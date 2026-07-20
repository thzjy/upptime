const severity = { gray: 0, green: 1, yellow: 2, orange: 3, red: 4 };

export function sampleColor(sample, check) {
  if (!sample) return "gray";
  if (sample.status === "down" || sample.status === "empty") return "red";
  if (!check) return "gray";
  if (check.ok) return "green";
  const code = Number(check.status_code || 0);
  if (code >= 500) return "orange";
  return "yellow";
}

export function timelineBuckets(samples, channelName, now = Date.now(), count = 60, bucketMinutes = 3) {
  const bucketMS = bucketMinutes * 60_000;
  const start = now - count * bucketMS;
  const buckets = Array.from({ length: count }, () => ({ sample: null, check: null, color: "gray" }));
  for (const sample of samples || []) {
    const at = Date.parse(sample.checked_at || "");
    if (!Number.isFinite(at) || at < start || at > now) continue;
    const index = Math.min(count - 1, Math.floor((at - start) / bucketMS));
    const check = (sample.checks || []).find((item) => item.name === channelName) || null;
    const color = sampleColor(sample, check);
    if (severity[color] >= severity[buckets[index].color]) buckets[index] = { sample, check, color };
  }
  return buckets;
}

export function timeWeightedAvailability(samples, channelName, endMS, windowMS = 24 * 60 * 60_000) {
  const points = [];
  for (const sample of samples || []) {
    const at = Date.parse(sample.checked_at || "");
    if (!Number.isFinite(at) || at > endMS) continue;
    const check = (sample.checks || []).find((item) => item.name === channelName);
    if (check) points.push({ at, ok: Boolean(check.ok) });
  }
  if (!points.length) return null;
  points.sort((left, right) => left.at - right.at);
  const startMS = endMS - windowMS;
  let currentOK = points[0].ok;
  for (const point of points) {
    if (point.at > startMS) break;
    currentOK = point.ok;
  }
  let cursor = startMS;
  let healthyMS = 0;
  for (const point of points) {
    if (point.at <= startMS) continue;
    if (point.at > cursor && currentOK) healthyMS += point.at - cursor;
    cursor = Math.max(cursor, point.at);
    currentOK = point.ok;
  }
  if (cursor < endMS && currentOK) healthyMS += endMS - cursor;
  return healthyMS / windowMS * 100;
}
