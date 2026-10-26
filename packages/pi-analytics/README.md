# pi-analytics

Cost and prompt-cache analytics for Pi sessions, outside Pi Desktop. It reads the same session files with the same code as the app's Analytics view, writes the same view as one HTML file, and tells you whether keep-warm pings would have saved money, and how many.

## Build and install

The package is built from Pi Desktop's sources:

```bash
npm install
npm run build:pi-analytics
pi install ./packages/pi-analytics      # the /analytics command and cache modes in every Pi session
npm link ./packages/pi-analytics        # optional: the pi-analytics command on your PATH
```

## Commands

The same commands run as `pi-analytics <command>` in a terminal or `/analytics <command>` inside Pi.

| Command | What it does |
|---|---|
| `report [--range 7\|30\|90\|365\|all] [--out file] [--no-open] [--rebuild]` | Writes the HTML report to `~/.pi/agent/pi-analytics/reports/` and opens it. Default range: 30 days. |
| `cache [--range ...] [--details 5m\|30m]` | Per cache lifetime and model: the hit rate, the ping count that would have cost least, and what it saves a week. `--details` adds every count's cost, the per-model and per-break comparisons, and the last two weeks side by side. |

The cache analysis is read only for now: it recommends, it does not apply. It replays your calls the way Pi warms: a refresh at 90% of the lifetime, and no more than fit in the 30 minutes Pi keeps warming after a run (6 on a 5-minute cache, 1 on a 30-minute one). A model with fewer than 10 breaks longer than its lifetime borrows its group's answer.

## Files

Everything lives in `~/.pi/agent/pi-analytics/` (`PI_ANALYTICS_DIR` overrides it; `PI_CODING_AGENT_DIR` moves Pi's agent folder):

- `sessions/<session id>.mode`: `{ "mode": "keep-warm", "changedAt": 1792947193283 }`, a mode picked for one session.
- `sessions/<session id>.status.json`: what the extension is doing for the session (mode and where it came from, retention, idle refresh limit and count, last request and refresh). The same object is sent as `pi-analytics:status` on `pi.events`.
- `analytics.sqlite`, `archive/`: the session index and copies of delegate sessions from the temp folder.

A session's mode is its `.mode` file, else `PI_ANALYTICS_CACHE_MODE` (or Pi Desktop's `PI_DESKTOP_CACHE_MODE`). With none of those, the extension leaves Pi alone. When a mode applies, it sets `PI_CACHE_RETENTION` before each request, fills in the vendor's cache lifetime for models Pi's catalog has none for (so Pi's warmer covers Copilot and OpenAI models), and answers Pi's idle `cache_warming_decision` events. It is meant to be the only extension answering those.
