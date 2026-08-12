import { fetchJSONWithRetry, getLocalStorage, readStorageJSON, writeStorageJSON } from "./monitor_logic.mjs?v=20260809-4";

const COPY = {
  zh: {
    title: "最近调用失败", total: "24 小时失败", empty: "最近 24 小时没有记录到调用失败",
    stale: "当前显示上次成功取得的数据", time: "时间", model: "模型", kind: "类型", category: "失败类别",
    unknown: "未标明模型", request_4xx: "请求失败", upstream_5xx: "上游服务异常", timeout: "超时",
    dns: "DNS 解析失败", auth: "认证或权限", quota: "配额或限流", provider_failure: "供应商失败",
  },
  en: {
    title: "Recent call failures", total: "failures in 24h", empty: "No call failures recorded in the last 24 hours",
    stale: "Showing the last successfully fetched report", time: "Time", model: "Model", kind: "Kind", category: "Category",
    unknown: "Unknown model", request_4xx: "Request failed", upstream_5xx: "Upstream error", timeout: "Timeout",
    dns: "DNS failure", auth: "Authentication or access", quota: "Quota or rate limit", provider_failure: "Provider failure",
  },
};

export function initFailureMonitor({ apiBase, authToken = "", lang = "zh" }) {
  const root = document.getElementById("failure-monitor");
  if (!root) return () => {};
  const copy = COPY[lang] || COPY.en;
  const storage = getLocalStorage(window);
  const cacheKey = `probeFailureCache:v1:${apiBase}`;
  let last = readStorageJSON(storage, cacheKey);

  const render = (report, stale = false) => {
    root.replaceChildren();
    const panel = node("article", "failure-panel");
    const header = node("header");
    header.append(node("h2", "", copy.title), node("span", "failure-total", `${Number(report?.total) || 0} ${copy.total}`));
    panel.append(header);
    if (stale) panel.append(node("p", "failure-note", copy.stale));
    const groups = Array.isArray(report?.groups) ? report.groups.slice(0, 8) : [];
    if (groups.length) {
      const groupGrid = node("div", "failure-groups");
      for (const group of groups) {
        const card = node("div", "failure-group");
        card.append(node("b", "", `${group.model || copy.unknown} · ${Number(group.count) || 0}`));
        card.append(node("span", "", `${group.media_kind || "-"} · ${label(copy, group.error_class)}`));
        groupGrid.append(card);
      }
      panel.append(groupGrid);
    }
    const recent = Array.isArray(report?.recent) ? report.recent.slice(0, 20) : [];
    if (!recent.length) {
      panel.append(node("p", "failure-empty", copy.empty));
    } else {
      const table = node("table", "failure-table");
      const head = node("tr");
      for (const title of [copy.time, copy.model, copy.kind, copy.category]) head.append(node("th", "", title));
      table.append(node("thead", "", head));
      const body = node("tbody");
      for (const event of recent) {
        const row = node("tr");
        row.append(
          node("td", "", formatTime(event.occurred_at, lang)), node("td", "", event.model || copy.unknown),
          node("td", "", event.media_kind || "-"), node("td", "", label(copy, event.error_class)),
        );
        body.append(row);
      }
      table.append(body); panel.append(table);
    }
    root.append(panel);
  };

  if (last) render(last, true);
  const load = async () => {
    try {
      const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
      const report = await fetchJSONWithRetry(`${apiBase}/probe/failures?hours=24&limit=50`, {
        attempts: 3, headers, retryDelayMS: 300, timeoutMS: 8000,
      });
      if (!report || !Array.isArray(report.recent) || !Array.isArray(report.groups)) throw new Error("invalid failure report");
      last = report; writeStorageJSON(storage, cacheKey, report); render(report, false);
    } catch {
      if (last) render(last, true);
    }
  };
  load();
  const timer = setInterval(load, 60000);
  return () => clearInterval(timer);
}

function node(tag, className = "", text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text instanceof Node) element.append(text);
  else if (text !== undefined) element.textContent = String(text);
  return element;
}

function label(copy, value) { return copy[value] || value || copy.provider_failure; }
function formatTime(raw, lang) {
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString(lang === "zh" ? "zh-CN" : "en-US", { hour12: false });
}
