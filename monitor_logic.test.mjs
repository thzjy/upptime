import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
	compactHistoryForCache,
	fetchJSONWithRetry,
	getLocalStorage,
	isSharedInfrastructureSample,
	latestChannelObservation,
	mergeHistorySamples,
	normalizeApiBase,
	readStorageJSON,
	readStorageText,
	sampleColor,
	sampledAvailability,
	timelineSamples,
	writeStorageJSON,
} from "./monitor_logic.mjs";

test("timeline cells cannot overflow and cover their gaps", () => {
  const html = fs.readFileSync(new URL("./index.html", import.meta.url), "utf8");
  assert.match(html, /border-right:\s*1px solid var\(--panel\)/);
  assert.match(html, /grid-template-columns:\s*repeat\(180,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(html, /\.cell\s*\{[^}]*width:\s*100%/s);
  assert.match(html, /\.empty\s*\{\s*color:\s*var\(--gray\)/);
  assert.match(html, /fractionalSecondDigits:\s*3/);
});

const check = (ok, status = ok ? 200 : 503, extra = {}) => ({ name: "channel", ok, status_code: status, ...extra });
const sample = (at, ok, extraCheck = {}) => ({
	checked_at: new Date(at).toISOString(), status: ok ? "healthy" : "down", checks: [check(ok, undefined, extraCheck)],
});

test("timeline retains all 180 real samples despite interval jitter", () => {
	const start = Date.parse("2026-07-20T02:00:00Z");
	const rows = Array.from({ length: 180 }, (_, index) => {
		const batchAt = start + index * 60_000 + (index % 2 ? 4_800 : -3_200);
		const checkedAt = batchAt + 731;
		return sample(batchAt, true, { checked_at: new Date(checkedAt).toISOString() });
	});
	const cells = timelineSamples(rows, "channel");
	assert.equal(cells.length, 180);
	assert.equal(cells.filter((cell) => !cell.check).length, 0);
	assert.equal(cells.filter((cell) => cell.color === "gray").length, 0);
	assert.equal(cells[0].checkedAt, rows[0].checks[0].checked_at);
	assert.equal(cells[179].checkedAt, rows[179].checks[0].checked_at);
});

test("a new refresh advances the sequence without creating artificial holes", () => {
	const start = Date.parse("2026-07-20T02:00:00Z");
	const rows = Array.from({ length: 181 }, (_, index) => sample(
		start + index * 60_000 + (index % 3) * 2_700,
		true,
	));
	const before = timelineSamples(rows.slice(0, 180), "channel");
	const after = timelineSamples(rows, "channel");
	assert.equal(before.every((cell) => cell.check && cell.color === "green"), true);
	assert.equal(after.every((cell) => cell.check && cell.color === "green"), true);
	assert.equal(after[0].sample.checked_at, rows[1].checked_at);
	assert.equal(after[179].sample.checked_at, rows[180].checked_at);
});

test("short history is padded only on the left", () => {
	const now = Date.parse("2026-07-20T02:00:00Z");
	const cells = timelineSamples([sample(now - 60_000, false), sample(now, true)], "channel", 4);
	assert.deepEqual(cells.map((cell) => cell.color), ["gray", "gray", "orange", "green"]);
	assert.equal(cells[0].bucketAt, null);
	assert.equal(cells[3].check.status_code, 200);
	assert.deepEqual(timelineSamples([sample(now, true)], "channel", 0), []);
});

test("availability uses the latest 1440 real sampling batches", () => {
	const end = Date.parse("2026-07-20T02:00:00Z");
	const rows = Array.from({ length: 1441 }, (_, index) => sample(end - (1440 - index) * 60_000, index !== 1440));
	assert.equal(sampledAvailability(rows, "channel"), 1439 / 1440 * 100);
});

test("missing channel checks are gray and do not affect availability", () => {
	const now = Date.parse("2026-07-20T02:00:00Z");
	const missing = { checked_at: new Date(now - 60_000).toISOString(), status: "down", checks: [] };
	const rows = [sample(now - 120_000, true), missing, sample(now, false)];
	assert.equal(sampleColor(missing, null), "gray");
	assert.equal(timelineSamples([missing], "channel")[179].color, "gray");
	assert.equal(sampledAvailability(rows, "channel"), 50);
});

test("legacy synthetic fetch-failure samples are ignored", () => {
	const now = Date.parse("2026-07-20T02:00:00Z");
	const real = sample(now - 60_000, true);
	const synthetic = { ...sample(now, false), synthetic: true };
	assert.equal(timelineSamples([real, synthetic], "channel")[179].color, "green");
	assert.equal(sampledAvailability([real, synthetic], "channel"), 100);
	assert.equal(latestChannelObservation([real, synthetic], "channel").sample.synthetic, undefined);
});

test("shared transport failures are yellow and count as failed channel observations", () => {
	const now = Date.parse("2026-07-20T02:00:00Z");
	const lastReal = sample(now - 60_000, true);
	const sharedFailure = {
		checked_at: new Date(now).toISOString(),
		status: "down",
		checks: [
			check(false, 0, { error: "shared dns failure" }),
			{ ...check(false, 0, { error: "shared dns failure" }), name: "other-channel" },
		],
	};
	assert.equal(isSharedInfrastructureSample(sharedFailure), true);
	assert.equal(sampleColor(sharedFailure, sharedFailure.checks[0]), "yellow");
	const cell = timelineSamples([lastReal, sharedFailure], "channel")[179];
	assert.equal(cell.color, "yellow");
	assert.equal(cell.check.error, "shared dns failure");
	assert.equal(sampledAvailability([lastReal, sharedFailure], "channel"), 50);
	assert.equal(latestChannelObservation([lastReal, sharedFailure], "channel").checkedAt, sharedFailure.checked_at);
	const cached = compactHistoryForCache({ samples: [lastReal, sharedFailure] }, 2);
	assert.equal(cached.classification_version, 2);
	assert.equal(cached.cached_availability.channel, 50);
});

test("channel timestamps override summary timestamps with legacy fallback", () => {
	const now = Date.parse("2026-07-20T02:00:00Z");
	const oldSummary = sample(now - 30 * 60_000, true, { checked_at: new Date(now - 60_000).toISOString() });
	const legacy = sample(now - 2 * 60_000, false);
	const cells = timelineSamples([oldSummary, legacy], "channel", 2);
	assert.equal(cells[0].color, "green");
	assert.equal(cells[0].checkedAt, new Date(now - 60_000).toISOString());
	assert.equal(cells[1].color, "orange");
	assert.equal(cells[1].checkedAt, legacy.checked_at);
	assert.equal(latestChannelObservation([legacy, oldSummary], "channel").checkedAt, new Date(now - 60_000).toISOString());
	const malformedCheckTime = sample(now, true, { checked_at: "not-a-time" });
	assert.equal(latestChannelObservation([malformedCheckTime], "channel").checkedAt, malformedCheckTime.checked_at);
});

test("history merging preserves a newer successful window across short or empty responses", () => {
	const start = Date.parse("2026-07-20T02:00:00Z");
	const previous = Array.from({ length: 5 }, (_, index) => ({
		...sample(start + index * 60_000, true),
		marker: `old-${index}`,
	}));
	const incoming = [
		{ ...sample(start + 2 * 60_000, false), marker: "replacement" },
		{ ...sample(start + 3 * 60_000, true), marker: "incoming-old" },
	];
	const merged = mergeHistorySamples(previous, incoming, 5);
	assert.equal(merged.length, 5);
	assert.deepEqual(merged.map((row) => row.marker), ["old-0", "old-1", "replacement", "incoming-old", "old-4"]);
	assert.deepEqual(mergeHistorySamples(previous, [], 5), previous);
	assert.equal(merged.at(-1).checked_at, previous.at(-1).checked_at);
});

test("history merging appends newer batches, sorts, and enforces the limit", () => {
	const start = Date.parse("2026-07-20T02:00:00Z");
	const previous = [sample(start, true), sample(start + 60_000, true)];
	const incoming = [sample(start + 180_000, true), sample(start + 120_000, true)];
	const merged = mergeHistorySamples(previous, incoming, 3);
	assert.deepEqual(merged.map((row) => row.checked_at), incoming
		.map((row) => row.checked_at)
		.concat(previous[1].checked_at)
		.sort());
});

test("cache projection keeps the visible timeline and exact 24h availability", () => {
	const start = Date.parse("2026-07-20T02:00:00Z");
	const rows = Array.from({ length: 1440 }, (_, index) => ({
		...sample(start + index * 60_000, index !== 1439),
		stable_for_seconds: index,
		checks: [{ ...check(index !== 1439), stable_for_seconds: index, provider_payload: "unused" }],
	}));
	const full = { total_samples: 1440, interval_seconds: 60, samples: rows };
	const compact = compactHistoryForCache(full);
	assert.equal(compact.samples.length, 180);
	assert.equal(compact.source_returned_samples, 1440);
	assert.equal(compact.cached_availability.channel, 1439 / 1440 * 100);
	assert.equal("stable_for_seconds" in compact.samples[0], false);
	assert.equal("provider_payload" in compact.samples[0].checks[0], false);
	assert.equal(JSON.stringify(compact).length < JSON.stringify(full).length / 3, true);
	assert.deepEqual(compactHistoryForCache(full, 0).samples, []);
});

test("API base accepts HTTPS and local development only", () => {
	const fallback = "https://probe.d2capi.com";
	assert.equal(normalizeApiBase("https://status.example.com/root/?x=1#hash", fallback), "https://status.example.com/root");
	assert.equal(normalizeApiBase("http://127.0.0.1:8765/", fallback), "http://127.0.0.1:8765");
	assert.equal(normalizeApiBase("http://[::1]:8765/", fallback), "http://[::1]:8765");
	assert.equal(normalizeApiBase("http://status.example.com", fallback), fallback);
	assert.equal(normalizeApiBase("javascript:alert(1)", fallback), fallback);
	assert.equal(normalizeApiBase("https://user:secret@status.example.com", fallback), fallback);
});

test("status-code colors distinguish connection, server, and other HTTP failures", () => {
	const row = { status: "degraded" };
	assert.equal(sampleColor(row, check(false, 0)), "red");
	assert.equal(sampleColor(row, check(false, 503)), "orange");
	assert.equal(sampleColor(row, check(false, 429)), "yellow");
});

test("history fetch retries transient failures with bounded backoff", async () => {
	let calls = 0;
	const delays = [];
	let requestOptions = null;
	const payload = await fetchJSONWithRetry("https://probe.invalid/history", {
		attempts: 3,
		fetchImpl: async (_url, options) => {
			requestOptions = options;
			calls += 1;
			if (calls < 3) throw new Error("network unavailable");
			return { ok: true, json: async () => ({ samples: [] }) };
		},
		retryDelayMS: 10,
		sleep: async (delay) => delays.push(delay),
	});
	assert.deepEqual(payload, { samples: [] });
	assert.equal(calls, 3);
	assert.deepEqual(delays, [10, 20]);
	assert.equal(requestOptions.redirect, "error");
});

test("history fetch does not retry non-retryable HTTP failures", async () => {
	let calls = 0;
	await assert.rejects(() => fetchJSONWithRetry("https://probe.invalid/history", {
		attempts: 3,
		fetchImpl: async () => {
			calls += 1;
			return { ok: false, status: 404 };
		},
		sleep: async () => assert.fail("404 must not be retried"),
	}), /HTTP 404/);
	assert.equal(calls, 1);
});

test("blocked local storage degrades to an empty cache without throwing", () => {
	const blockedScope = {};
	Object.defineProperty(blockedScope, "localStorage", { get: () => { throw new Error("blocked"); } });
	assert.equal(getLocalStorage(blockedScope), null);
	const blockedStorage = {
		getItem: () => { throw new Error("blocked"); },
		setItem: () => { throw new Error("blocked"); },
	};
	assert.equal(readStorageText(blockedStorage, "key"), "");
	assert.equal(readStorageJSON(blockedStorage, "key"), null);
	assert.equal(writeStorageJSON(blockedStorage, "key", { ok: true }), false);
});

test("dashboard fetch failures render stale cache without synthetic channel samples", () => {
	const html = fs.readFileSync(new URL("./index.html", import.meta.url), "utf8");
	assert.doesNotMatch(html, /failedHistoryFromCache|synthetic:\s*true|allChannelsFailed/);
	assert.doesNotMatch(html, /purple|infrastructureFailure|sharedProbeFailure/);
	assert.match(html, /4xx \/ 请求失败/);
	assert.match(html, /fetchJSONWithRetry/);
	assert.match(html, /let lastSuccessfulHistory = null/);
	assert.match(html, /incoming\.samples\.length < expectedSamples/);
	assert.match(html, /latestIncoming\.checks\?\.length < expectedChannels/);
	assert.match(html, /lastSuccessfulHistory \|\| readCachedHistory\(\)/);
	assert.match(html, /const initialCache = readCachedHistory\(\)/);
	assert.match(html, /render\(\{ \.\.\.initialCache, stale: true \}\)/);
	assert.match(html, /compactHistoryForCache/);
	assert.match(html, /probeHistoryCache:v2:/);
	assert.match(html, /readStorageJSON\(storage, cacheKey\) \|\| readStorageJSON\(storage, legacyCacheKey\)/);
	assert.match(html, /cached\.classification_version === 2/);
	assert.match(html, /compactStaleCache \? null/);
	assert.match(html, /apiBase === configuredApi/);
	assert.match(html, /escapeHtml\(fmtTime\(observation\?\.checkedAt\)\)/);
	assert.match(html, /stale:\s*Boolean\(cached\?\.samples\?\.length\)/);
	assert.match(html, /data\.stale\s*\?\s*"empty"/);
	assert.match(html, /mergeHistorySamples/);
	assert.match(html, /latestChannelObservation/);
	assert.match(html, /fmtTime\(checkedAt\)/);
});
