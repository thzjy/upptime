const severity = { gray: 0, green: 1, yellow: 2, orange: 3, red: 4 };

export function getLocalStorage(scope = globalThis) {
  try {
    return scope.localStorage || null;
  } catch {
    return null;
  }
}

export function readStorageText(storage, key) {
  try {
    return storage?.getItem(key) || "";
  } catch {
    return "";
  }
}

export function readStorageJSON(storage, key) {
  try {
    return JSON.parse(storage?.getItem(key) || "null");
  } catch {
    return null;
  }
}

export function writeStorageJSON(storage, key, value) {
  try {
    storage?.setItem(key, JSON.stringify(value));
    return Boolean(storage);
  } catch {
    return false;
  }
}

export function observationTime(sample, check) {
  for (const raw of [check?.checked_at, sample?.checked_at]) {
    const at = Date.parse(raw || "");
    if (Number.isFinite(at)) return { raw, at };
  }
  return null;
}

export function historySampleTime(sample) {
  const times = [sample?.checked_at, ...(sample?.checks || []).map((check) => check?.checked_at)]
    .map((raw) => Date.parse(raw || ""))
    .filter(Number.isFinite);
  return times.length ? Math.max(...times) : Number.NaN;
}

export function latestChannelObservation(samples, channelName) {
  let latest = null;
  for (const sample of samples || []) {
    if (sample?.synthetic || isSharedInfrastructureSample(sample)) continue;
    const check = (sample.checks || []).find((item) => item.name === channelName) || null;
    const time = observationTime(sample, check);
    if (!check || !time) continue;
    if (!latest || time.at >= latest.at) latest = { sample, check, checkedAt: time.raw, at: time.at };
  }
  return latest;
}

export function isSharedInfrastructureSample(sample) {
  const checks = Array.isArray(sample?.checks) ? sample.checks : [];
  return checks.length > 1 && checks.every((check) => (
    !check?.ok
    && Number(check?.status_code || 0) === 0
    && String(check?.error || "").trim() !== ""
  ));
}

export function sampleColor(sample, check) {
  if (!sample || !check) return "gray";
  if (isSharedInfrastructureSample(sample)) return "gray";
  if (check.ok) return "green";
  const code = Number(check.status_code || 0);
  if (code === 0) return "red";
  if (code >= 500) return "orange";
  return "yellow";
}

export function timelineBuckets(samples, channelName, now = Date.now(), count = 180, bucketMinutes = 1) {
  const bucketMS = bucketMinutes * 60_000;
  const start = now - (count - 1) * bucketMS;
  const buckets = Array.from({ length: count }, (_, index) => ({
    sample: null,
    check: null,
    checkedAt: null,
    bucketAt: start + index * bucketMS,
    color: "gray",
  }));
  for (const sample of samples || []) {
    if (sample?.synthetic) continue;
    const check = (sample.checks || []).find((item) => item.name === channelName) || null;
    const time = observationTime(sample, check);
    if (!check || !time || time.at < start || time.at > now) continue;
    const index = Math.min(count - 1, Math.floor((time.at - start) / bucketMS));
    const color = sampleColor(sample, check);
    if (severity[color] >= severity[buckets[index].color]) {
      buckets[index] = { ...buckets[index], sample, check, checkedAt: time.raw, color };
    }
  }
  return buckets;
}

export function sampledAvailability(samples, channelName, limit = 1440) {
  const windowSamples = (samples || []).slice(-limit);
  let healthy = 0;
  let observed = 0;
  for (const sample of windowSamples) {
    if (sample?.synthetic || isSharedInfrastructureSample(sample)) continue;
    const check = (sample.checks || []).find((item) => item.name === channelName);
    if (!check || !observationTime(sample, check)) continue;
    observed += 1;
    if (check.ok) healthy += 1;
  }
  return observed ? healthy / observed * 100 : null;
}

export async function fetchJSONWithRetry(url, options = {}) {
  const {
    attempts = 3,
    cache = "no-store",
    fetchImpl = globalThis.fetch,
    headers = {},
    retryDelayMS = 250,
    sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
    timeoutMS = 8_000,
  } = options;
  let lastError = new Error("request failed");
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMS);
    try {
      const response = await fetchImpl(url, { cache, headers, signal: controller.signal });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw error;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= Math.max(1, attempts) || error?.retryable === false) throw error;
      await sleep(retryDelayMS * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}
