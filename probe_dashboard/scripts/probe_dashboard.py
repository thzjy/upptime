#!/usr/bin/env python3
import html
import json
import os
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "pages"
DATA_DIR = OUT_DIR / "data"
HISTORY_PATH = DATA_DIR / "probe-history.json"
DASHBOARD_PATH = DATA_DIR / "probe-dashboard.json"
INDEX_PATH = OUT_DIR / "index.html"
LOGO_SOURCE = ROOT.parent / "docs-logox" / "public" / "logo.svg"
LOGO_PATH = OUT_DIR / "logo.svg"
MAX_HISTORY = int(os.getenv("PROBE_HISTORY_LIMIT", "5000"))
GRID_SIZE = int(os.getenv("PROBE_GRID_SIZE", "100"))
DISPLAY_TZ = timezone(timedelta(hours=8))


def utc_now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def format_time(raw):
    if not raw:
        return "无数据"
    try:
        dt = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return str(raw)
    return dt.astimezone(DISPLAY_TZ).strftime("%Y-%m-%d %H:%M:%S")


def load_history():
    if not HISTORY_PATH.exists():
        return []
    try:
        data = json.loads(HISTORY_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except json.JSONDecodeError:
        return []


def fetch_summary():
    url = os.getenv("PROBE_SUMMARY_URL", "https://tgw.logox.top/probe/summary")
    token = os.getenv("PROBE_AUTH_TOKEN", "").strip()
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            status_code = response.getcode()
            raw = response.read().decode("utf-8", errors="replace")
        payload = json.loads(raw)
        if status_code != 200:
            raise RuntimeError(f"unexpected HTTP status {status_code}")
        return {
            "time": utc_now(),
            "gateway_ok": True,
            "summary": payload.get("summary", {}),
            "checks": payload.get("checks", []),
        }
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, RuntimeError) as exc:
        return {
            "time": utc_now(),
            "gateway_ok": False,
            "error": str(exc),
            "checks": [],
        }


def known_channel_names(history):
    channels = []
    seen = set()
    for check in latest_checks(history):
        name = check.get("name")
        if name and name not in seen:
            seen.add(name)
            channels.append({
                "name": name,
                "display_name": check.get("display_name") or name,
            })
    return channels


def latest_checks(history):
    for sample in reversed(history):
        checks = sample.get("checks", [])
        if sample.get("gateway_ok") and checks:
            return checks
    return []


def check_color(sample, check):
    if not sample.get("gateway_ok"):
        return "red"
    if check is None:
        return "gray"
    if check.get("ok") is True:
        return "green"
    code = check.get("status_code")
    if code == 200:
        return "blue"
    if isinstance(code, int) and 400 <= code <= 499:
        return "yellow"
    if isinstance(code, int) and 500 <= code <= 599:
        return "orange"
    return "red"


def unhealthy_key(sample, check):
    if not sample.get("gateway_ok"):
        return "gateway_down"
    if check is None or check.get("ok") is True:
        return None
    code = check.get("status_code")
    error = check.get("error") or "unhealthy"
    if code:
        return f"{code}:{error}"
    return f"error:{error}"


def current_for_channel(history, name):
    for sample in reversed(history):
        if not sample.get("gateway_ok"):
            return {
                "ok": False,
                "state": "gateway_down",
                "latency_ms": None,
                "status_code": None,
                "error": sample.get("error", "gateway_down"),
            }
        check = next((item for item in sample.get("checks", []) if item.get("name") == name), None)
        if check is not None:
            return {
                "ok": check.get("ok") is True,
                "state": "up" if check.get("ok") is True else "unhealthy",
                "model": check.get("model"),
                "latency_ms": check.get("latency_ms"),
                "status_code": check.get("status_code"),
                "error": check.get("error"),
            }
    return {"ok": None, "state": "no_data"}


def build_dashboard(history):
    known_channels = known_channel_names(history)
    recent = history[-GRID_SIZE:]
    channels = []
    for known in known_channels:
        name = known["name"]
        cells = []
        errors = Counter()
        for sample in recent:
            check = next((item for item in sample.get("checks", []) if item.get("name") == name), None)
            color = check_color(sample, check)
            key = unhealthy_key(sample, check)
            if key:
                errors[key] += 1
            cells.append({
                "time": sample.get("time"),
                "color": color,
                "status_code": None if check is None else check.get("status_code"),
                "error": sample.get("error") if not sample.get("gateway_ok") else (None if check is None else check.get("error")),
            })
        while len(cells) < GRID_SIZE:
            cells.insert(0, {"time": None, "color": "gray", "status_code": None, "error": "no_data"})
        channels.append({
            "name": name,
            "display_name": known["display_name"],
            "current": current_for_channel(history, name),
            "history": cells,
            "unhealthy_stats": [
                {"key": key, "count": count}
                for key, count in errors.most_common(8)
            ],
        })

    latest = history[-1] if history else {}
    gateway_ok = latest.get("gateway_ok") is True
    gateway_state = "up" if gateway_ok else "down"
    if gateway_ok:
        summary = latest.get("summary", {})
        if summary.get("unhealthy", 0) > 0:
            gateway_state = "degraded"
    return {
        "updated_at": utc_now(),
        "gateway": {
            "ok": gateway_ok,
            "state": gateway_state,
            "last_error": latest.get("error"),
        },
        "summary": latest.get("summary", {}),
        "channels": channels,
    }


def status_label(current):
    state = current.get("state", "no_data")
    if state == "up":
        return "UP"
    if state == "gateway_down":
        return "GATEWAY DOWN"
    if state == "unhealthy":
        return "UNHEALTHY"
    return "NO DATA"


def render_html(dashboard):
    channels_html = []
    for channel in dashboard["channels"]:
        current = channel["current"]
        cells = "".join(
            f'<span class="cell {cell["color"]}" title="{html.escape(format_time(cell.get("time")))} '
            f'{html.escape(str(cell.get("status_code") or ""))} {html.escape(str(cell.get("error") or ""))}"></span>'
            for cell in channel["history"]
        )
        stats = channel["unhealthy_stats"]
        stats_html = "".join(
            f'<span class="stat"><b>{html.escape(item["key"])}</b> x{item["count"]}</span>'
            for item in stats
        )
        model = current.get("model")
        model_html = f'<p>模型：{html.escape(str(model))}</p>' if model else ""
        latency = "-" if current.get("latency_ms") is None else f'{current.get("latency_ms")}ms'
        error = current.get("error")
        error_html = f'<span>错误：{html.escape(str(error))}</span>' if error else ""
        stats_block = f'<div class="stats"><span class="stats-label">异常统计</span>{stats_html}</div>' if stats_html else ""
        channels_html.append(f"""
        <section class="channel">
          <div class="channel-head">
            <div>
              <h2>{html.escape(channel["display_name"])}</h2>
              {model_html}
            </div>
            <div class="status {html.escape(current.get("state", "no_data"))}">{html.escape(status_label(current))}</div>
          </div>
          <div class="meta">
            <span>状态码：{html.escape(str(current.get("status_code") or "-"))}</span>
            <span>延迟：{html.escape(latency)}</span>
            {error_html}
          </div>
          <div class="grid">{cells}</div>
          {stats_block}
        </section>
        """)

    gateway = dashboard["gateway"]
    summary = dashboard.get("summary", {})
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LOGOX 渠道监控</title>
  <style>
    :root {{
      --bg: #f4efe6;
      --panel: #fffaf0;
      --ink: #1f261f;
      --muted: #667064;
      --line: #dfd4c1;
      --green: #1f9d55;
      --yellow: #d8a316;
      --orange: #df6b21;
      --red: #c9382e;
      --blue: #2775c7;
      --gray: #c6c6bf;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at 12% 8%, rgba(31, 157, 85, .16), transparent 28rem),
        radial-gradient(circle at 88% 0%, rgba(216, 163, 22, .18), transparent 26rem),
        linear-gradient(135deg, #f7f0df 0%, #eef3e8 100%);
      min-height: 100vh;
    }}
    main {{ max-width: 1180px; margin: 0 auto; padding: 42px 20px 64px; }}
    .hero {{
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 20px;
      align-items: end;
      margin-bottom: 22px;
    }}
    h1 {{ font-size: clamp(34px, 6vw, 70px); line-height: .9; margin: 0; letter-spacing: -.06em; }}
    .subtitle {{ color: var(--muted); margin: 12px 0 0; }}
    .badge {{
      border: 1px solid var(--line);
      background: rgba(255, 250, 240, .72);
      border-radius: 22px;
      padding: 16px 18px;
      min-width: 250px;
      box-shadow: 0 16px 40px rgba(50, 45, 35, .08);
    }}
    .badge strong {{ display: block; font-size: 28px; text-transform: uppercase; }}
    .badge.up strong {{ color: var(--green); }}
    .badge.degraded strong {{ color: var(--yellow); }}
    .badge.down strong {{ color: var(--red); }}
    .cards {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 20px 0 28px; }}
    .card {{ background: rgba(255, 250, 240, .72); border: 1px solid var(--line); border-radius: 18px; padding: 15px; }}
    .card b {{ display: block; font-size: 26px; }}
    .card span, .muted {{ color: var(--muted); }}
    .legend {{ display: flex; flex-wrap: wrap; gap: 10px; margin: 0 0 18px; color: var(--muted); font-size: 13px; }}
    .legend span {{ display: inline-flex; align-items: center; gap: 6px; }}
    .dot {{ width: 12px; height: 12px; border-radius: 4px; display: inline-block; }}
    .channel {{
      background: rgba(255, 250, 240, .78);
      border: 1px solid var(--line);
      border-radius: 22px;
      padding: 18px;
      margin: 12px 0;
      box-shadow: 0 18px 50px rgba(50, 45, 35, .07);
    }}
    .channel-head {{ display: flex; justify-content: space-between; gap: 16px; align-items: start; }}
    h2 {{ margin: 0; font-size: 18px; }}
    .channel p {{ margin: 5px 0 0; color: var(--muted); }}
    .status {{ border-radius: 999px; padding: 7px 11px; font-size: 12px; font-weight: 800; white-space: nowrap; }}
    .status.up {{ color: #0f6f3a; background: rgba(31, 157, 85, .14); }}
    .status.unhealthy {{ color: #965b00; background: rgba(216, 163, 22, .18); }}
    .status.gateway_down {{ color: #9b211a; background: rgba(201, 56, 46, .16); }}
    .status.no_data {{ color: #666; background: rgba(120, 120, 120, .13); }}
    .meta {{ display: flex; flex-wrap: wrap; gap: 12px; color: var(--muted); font-size: 13px; margin-top: 12px; }}
    .grid {{ display: grid; grid-template-columns: repeat(100, minmax(4px, 1fr)); gap: 3px; margin: 16px 0 12px; }}
    .cell {{ height: 18px; border-radius: 5px; box-shadow: inset 0 -1px 0 rgba(0,0,0,.12); }}
    .green {{ background: var(--green); }}
    .yellow {{ background: var(--yellow); }}
    .orange {{ background: var(--orange); }}
    .red {{ background: var(--red); }}
    .blue {{ background: var(--blue); }}
    .gray {{ background: var(--gray); }}
    .stats {{ display: flex; flex-wrap: wrap; gap: 8px; }}
    .stats-label {{ color: var(--muted); font-size: 12px; line-height: 28px; }}
    .stat {{ background: rgba(31, 38, 31, .06); border: 1px solid rgba(31, 38, 31, .08); border-radius: 999px; padding: 6px 9px; font-size: 12px; color: var(--muted); }}
    @media (max-width: 820px) {{
      .hero, .cards {{ grid-template-columns: 1fr; }}
      .grid {{ grid-template-columns: repeat(50, minmax(5px, 1fr)); }}
    }}
  </style>
</head>
<body>
  <main>
    <header class="hero">
      <div>
        <h1>LOGOX 渠道监控</h1>
      </div>
      <div class="badge {html.escape(gateway.get("state", "down"))}">
        <strong>{html.escape(gateway.get("state", "down"))}</strong>
        <small>更新于 {html.escape(format_time(dashboard.get("updated_at")))}</small>
      </div>
    </header>

    <section class="cards">
      <div class="card"><b>{html.escape(str(summary.get("total", "-")))}</b><span>渠道总数</span></div>
      <div class="card"><b>{html.escape(str(summary.get("healthy", "-")))}</b><span>健康</span></div>
      <div class="card"><b>{html.escape(str(summary.get("unhealthy", "-")))}</b><span>异常</span></div>
      <div class="card"><b>{html.escape(str(summary.get("duration_ms", "-")))}</b><span>汇总耗时 ms</span></div>
    </section>

    <nav class="legend">
      <span><i class="dot green"></i>正常</span>
      <span><i class="dot blue"></i>未接入</span>
      <span><i class="dot yellow"></i>4xx</span>
      <span><i class="dot orange"></i>5xx</span>
      <span><i class="dot red"></i>网关失败/超时</span>
      <span><i class="dot gray"></i>无数据</span>
    </nav>

    {''.join(channels_html)}
  </main>
</body>
</html>
"""


def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if LOGO_SOURCE.exists():
        LOGO_PATH.write_text(LOGO_SOURCE.read_text(encoding="utf-8"), encoding="utf-8")
    history = load_history()
    history.append(fetch_summary())
    history = history[-MAX_HISTORY:]
    dashboard = build_dashboard(history)
    HISTORY_PATH.write_text(json.dumps(history, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    DASHBOARD_PATH.write_text(json.dumps(dashboard, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    INDEX_PATH.write_text(render_html(dashboard), encoding="utf-8")
    (OUT_DIR / ".nojekyll").write_text("", encoding="utf-8")
    print(f"gateway={dashboard['gateway']['state']} channels={len(dashboard['channels'])}")


if __name__ == "__main__":
    main()
