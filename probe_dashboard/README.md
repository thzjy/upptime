# Probe Dashboard

This is a static dashboard for the media gateway probe API. The page polls `/probe/history` directly, so production sampling is owned by `media_gateway` instead of GitHub Actions.

Open the page with an explicit API base when it is hosted away from the gateway:

```text
https://your-pages-host.example/?api=https://tgw.logox.top
```

The dashboard shows the latest summary and recent channel history from the gateway response.

## Legacy updater

GitHub scheduled workflows are best-effort and may be delayed or skipped, especially for high-frequency schedules. The updater scripts are kept as a fallback, but they are not the recommended production path.

## Reliable one-minute updates

Windows Task Scheduler command:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\work\open-ui-ai-platform\probe_dashboard\scripts\update_probe_dashboard.ps1
```

Linux cron command:

```cron
* * * * * cd /path/to/probe_dashboard && scripts/update_probe_dashboard.sh master
```

The updater runs `scripts/probe_dashboard.py`, commits `pages/`, and pushes to `origin master` when an `origin` remote is configured. Set `PROBE_AUTH_TOKEN` in the scheduled task environment if the gateway summary endpoint requires authorization.

The GitHub workflow remains available for manual runs and `repository_dispatch`, but it should be treated as a backup path rather than the primary one-minute scheduler.
