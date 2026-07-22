import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { sampledAvailability, timelineBuckets } from "./monitor_logic.mjs";

test("timeline cells cannot overflow and cover their gaps", () => {
  const html = fs.readFileSync(new URL("./index.html", import.meta.url), "utf8");
  assert.match(html, /gap:\s*1px/);
  assert.match(html, /\.cell\s*\{[^}]*width:\s*100%/s);
});

const check = (ok, status = ok ? 200 : 503) => ({ name: "channel", ok, status_code: status });
const sample = (at, ok, synthetic = false) => ({
  checked_at: new Date(at).toISOString(), synthetic, status: ok ? "healthy" : "down", checks: [check(ok)],
});

test("three-hour timeline uses 180 one-minute buckets", () => {
  const now = Date.parse("2026-07-20T02:00:00Z");
  const rows = [sample(now - 179 * 60_000, true), sample(now - 60_000, false)];
  const buckets = timelineBuckets(rows, "channel", now);
  assert.equal(buckets.length, 180);
  assert.equal(buckets[1].color, "green");
  assert.equal(buckets[179].color, "red");
});

test("each minute retains its own sample", () => {
  const now = Date.parse("2026-07-20T02:00:00Z");
  const rows = [sample(now - 120_000, false), sample(now - 60_000, true)];
  const buckets = timelineBuckets(rows, "channel", now);
  assert.equal(buckets[178].color, "red");
  assert.equal(buckets[179].color, "green");
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
