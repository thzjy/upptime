import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
	fetchJSONWithRetry,
	getLocalStorage,
	isSharedInfrastructureSample,
	latestChannelObservation,
	readStorageJSON,
	readStorageText,
	sampleColor,
	sampledAvailability,
	timelineBuckets,
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

test("three-hour timeline uses 180 one-minute buckets", () => {
  const now = Date.parse("2026-07-20T02:00:00Z");
  const rows = [sample(now - 179 * 60_000, true), sample(now - 60_000, false)];
	const buckets = timelineBuckets(rows, "channel", now);
	assert.equal(buckets.length, 180);
	assert.equal(buckets[0].color, "green");
	assert.equal(buckets[178].color, "orange");
});

test("each minute retains its own sample", () => {
  const now = Date.parse("2026-07-20T02:00:00Z");
	const rows = [sample(now - 120_000, false), sample(now - 60_000, true)];
	const buckets = timelineBuckets(rows, "channel", now);
	assert.equal(buckets[177].color, "orange");
	assert.equal(buckets[178].color, "green");
});

test("latest sample always occupies the final cell", () => {
  const now = Date.parse("2026-07-20T02:00:00Z");
  const buckets = timelineBuckets([sample(now, true)], "channel", now);
  assert.equal(buckets.length, 180);
  assert.equal(buckets[179].color, "green");
  assert.equal(buckets[179].check.status_code, 200);
});

test("availability uses the latest 1440 one-minute samples", () => {
	const end = Date.parse("2026-07-20T02:00:00Z");
	const rows = Array.from({ length: 1441 }, (_, index) => sample(end - (1440 - index) * 60_000, index !== 1440));
	assert.equal(sampledAvailability(rows, "channel"), 1439 / 1440 * 100);
});

test("missing channel checks are gray and do not affect availability", () => {
	const now = Date.parse("2026-07-20T02:00:00Z");
	const missing = { checked_at: new Date(now - 60_000).toISOString(), status: "down", checks: [] };
	const rows = [sample(now - 120_000, true), missing, sample(now, false)];
	assert.equal(sampleColor(missing, null), "gray");
	assert.equal(timelineBuckets([missing], "channel", now)[179].color, "gray");
	assert.equal(sampledAvailability(rows, "channel"), 50);
});

test("legacy synthetic fetch-failure samples are ignored", () => {
	const now = Date.parse("2026-07-20T02:00:00Z");
	const real = sample(now - 60_000, true);
	const synthetic = { ...sample(now, false), synthetic: true };
	assert.equal(timelineBuckets([real, synthetic], "channel", now)[178].color, "green");
	assert.equal(sampledAvailability([real, synthetic], "channel"), 100);
	assert.equal(latestChannelObservation([real, synthetic], "channel").sample.synthetic, undefined);
});

test("shared transport failures are gray and excluded from channel truth", () => {
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
	assert.equal(sampleColor(sharedFailure, sharedFailure.checks[0]), "gray");
	const bucket = timelineBuckets([lastReal, sharedFailure], "channel", now)[179];
	assert.equal(bucket.color, "gray");
	assert.equal(bucket.check.error, "shared dns failure");
	assert.equal(sampledAvailability([lastReal, sharedFailure], "channel"), 100);
	assert.equal(latestChannelObservation([lastReal, sharedFailure], "channel").checkedAt, lastReal.checked_at);
});

test("channel timestamps override summary timestamps with legacy fallback", () => {
	const now = Date.parse("2026-07-20T02:00:00Z");
	const oldSummary = sample(now - 30 * 60_000, true, { checked_at: new Date(now - 60_000).toISOString() });
	const legacy = sample(now - 2 * 60_000, false);
	const buckets = timelineBuckets([oldSummary, legacy], "channel", now);
	assert.equal(buckets[178].color, "green");
	assert.equal(buckets[177].color, "orange");
	assert.equal(buckets[178].checkedAt, new Date(now - 60_000).toISOString());
	assert.equal(latestChannelObservation([legacy, oldSummary], "channel").checkedAt, new Date(now - 60_000).toISOString());
	const malformedCheckTime = sample(now, true, { checked_at: "not-a-time" });
	assert.equal(latestChannelObservation([malformedCheckTime], "channel").checkedAt, malformedCheckTime.checked_at);
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
	const payload = await fetchJSONWithRetry("https://probe.invalid/history", {
		attempts: 3,
		fetchImpl: async () => {
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
	assert.match(html, /fetchJSONWithRetry/);
	assert.match(html, /stale:\s*Boolean\(cached\?\.samples\?\.length\)/);
	assert.match(html, /data\.stale\s*\?\s*"empty"/);
	assert.match(html, /!sample\?\.synthetic/);
	assert.match(html, /latestChannelObservation/);
	assert.match(html, /fmtTime\(checkedAt\)/);
});
