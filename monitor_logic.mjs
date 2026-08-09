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

export function normalizeApiBase(raw, fallback = "https://probe.d2capi.com") {
  const parse = (value) => {
    try {
      const url = new URL(String(value || ""));
      const localHTTP = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if ((url.protocol !== "https:" && !localHTTP) || url.username || url.password) return "";
      return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    } catch {
      return "";
    }
  };
  return parse(raw) || parse(fallback) || "https://probe.d2capi.com";
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

function batchSampleTime(sample) {
  const at = Date.parse(sample?.checked_at || "");
  return Number.isFinite(at) ? at : historySampleTime(sample);
}

export function latestChannelObservation(samples, channelName) {
  let latest = null;
  for (const sample of samples || []) {
    if (sample?.synthetic) continue;
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
  if (isSharedInfrastructureSample(sample)) return "yellow";
  if (check.ok) return "green";
  const code = Number(check.status_code || 0);
  if (code === 0) return "red";
  if (code >= 500) return "orange";
  return "yellow";
}

export function timelineSamples(samples, channelName, count = 180) {
  const size = Math.max(0, Math.trunc(Number(count) || 0));
  if (!size) return [];
  const batches = (Array.isArray(samples) ? samples : [])
    .filter((sample) => !sample?.synthetic && Number.isFinite(batchSampleTime(sample)))
    .sort((left, right) => batchSampleTime(left) - batchSampleTime(right))
    .slice(-size);
  const padding = Array.from({ length: Math.max(0, size - batches.length) }, () => ({
    sample: null,
    check: null,
    checkedAt: null,
    bucketAt: null,
    color: "gray",
  }));
  const observations = batches.map((sample) => {
    const check = (sample.checks || []).find((item) => item.name === channelName) || null;
    const time = observationTime(sample, check);
    return {
      sample,
      check,
      checkedAt: time?.raw || null,
      bucketAt: time?.at ?? batchSampleTime(sample),
      color: sampleColor(sample, check),
    };
  });
  return [...padding, ...observations];
}

export function mergeHistorySamples(previousSamples, incomingSamples, limit = 1440) {
  const size = Math.max(0, Math.trunc(Number(limit) || 0));
  if (!size) return [];
  const batches = new Map();
  const add = (samples) => {
    for (const sample of Array.isArray(samples) ? samples : []) {
      if (sample?.synthetic) continue;
      const at = batchSampleTime(sample);
      if (Number.isFinite(at)) batches.set(at, sample);
    }
  };
  add(previousSamples);
  add(incomingSamples);
  return [...batches.entries()]
    .sort(([left], [right]) => left - right)
    .slice(-size)
    .map(([, sample]) => sample);
}

export function sampledAvailability(samples, channelName, limit = 1440) {
  const windowSamples = (samples || []).slice(-limit);
  let healthy = 0;
  let observed = 0;
  for (const sample of windowSamples) {
    if (sample?.synthetic) continue;
    const check = (sample.checks || []).find((item) => item.name === channelName);
    if (!check || !observationTime(sample, check)) continue;
    observed += 1;
    if (check.ok) healthy += 1;
  }
  return observed ? healthy / observed * 100 : null;
}

export function compactHistoryForCache(data, limit = 180) {
  const samples = Array.isArray(data?.samples) ? data.samples : [];
  const channelNames = [...new Set(samples.flatMap((sample) => (
    Array.isArray(sample?.checks) ? sample.checks.map((check) => check?.name).filter(Boolean) : []
  )))];
  const cachedAvailability = Object.fromEntries(channelNames.map((name) => [
    name,
    sampledAvailability(samples, name),
  ]));
  const size = Math.max(0, Math.trunc(Number(limit) || 0));
  const compactSamples = (size ? samples.slice(-size) : []).map((sample) => ({
    status: sample?.status,
    checked_at: sample?.checked_at,
    stable_days: sample?.stable_days,
    summary: sample?.summary,
    checks: (Array.isArray(sample?.checks) ? sample.checks : []).map((check) => ({
      name: check?.name,
      display_name: check?.display_name,
      integration_status: check?.integration_status,
      ok: check?.ok,
      status_code: check?.status_code,
      latency_ms: check?.latency_ms,
      checked_at: check?.checked_at,
      error: check?.error,
    })),
  }));
  return {
    classification_version: 2,
    updated_at: data?.updated_at,
    interval_seconds: data?.interval_seconds,
    stable_days: data?.stable_days,
    total_samples: Math.max(Number(data?.total_samples) || 0, samples.length),
    returned_samples: compactSamples.length,
    source_returned_samples: Math.max(Number(data?.source_returned_samples) || 0, samples.length),
    cached_availability: cachedAvailability,
    samples: compactSamples,
  };
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
      const response = await fetchImpl(url, { cache, headers, redirect: "error", signal: controller.signal });
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
