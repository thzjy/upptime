import assert from "node:assert/strict";
import test from "node:test";
import { timelineBuckets, timeWeightedAvailability } from "./monitor_logic.mjs";

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

test("availability is weighted by elapsed time", () => {
  const end = Date.parse("2026-07-20T02:00:00Z");
  const start = end - 24 * 60 * 60_000;
  const rows = [sample(start, true), sample(start + 18 * 60 * 60_000, false)];
  assert.equal(timeWeightedAvailability(rows, "channel", end), 75);
});
