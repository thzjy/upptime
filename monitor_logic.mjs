const severity = { gray: 0, green: 1, yellow: 2, orange: 3, red: 4 };

export function sampleColor(sample, check) {
  if (!sample) return "gray";
  if (sample.status === "down" || sample.status === "empty") return "red";
  if (!check) return "gray";
  if (check.ok) return "green";
  const code = Number(check.status_code || 0);
  if (code === 0) return "red";
  if (code >= 500) return "orange";
  return "yellow";
}

export function timelineBuckets(samples, channelName, now = Date.now(), count = 180, bucketMinutes = 1) {
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

export function sampledAvailability(samples, channelName, limit = 1440) {
  const windowSamples = (samples || []).slice(-limit);
  let healthy = 0;
  let observed = 0;
  for (const sample of windowSamples) {
    const check = (sample.checks || []).find((item) => item.name === channelName);
    if (!check) continue;
    observed += 1;
    if (check.ok) healthy += 1;
  }
  return observed ? healthy / observed * 100 : null;
}
