# pi-analytics

Cost and prompt-cache analytics for Pi sessions, outside Pi Desktop. It reads the same session files with the same code as the app's Analytics view, writes the same view as one HTML file, and can put its cache recommendations into effect (and take them back).

## Build and install

The package is built from Pi Desktop's sources:

```bash
npm install
npm run build:pi-analytics
pi install ./packages/pi-analytics      # the /analytics command and the cache plan in every Pi session
npm link ./packages/pi-analytics        # optional: the pi-analytics command on your PATH
```

## Commands

The same commands run as `pi-analytics <command>` in a terminal or `/analytics <command>` inside Pi.

| Command | What it does |
|---|---|
| `report [--range 7\|30\|90\|365\|all] [--out file] [--no-open] [--rebuild]` | Writes the HTML report to `~/.pi/agent/pi-analytics/reports/` and opens it. Default range: 30 days. |
| `recommend [--range ...]` | Numbered cache settings that would have cost less, with the saving per week. |
| `apply <number>... \| all [--yes]` | Puts them into the cache plan. A setting that refreshes the cache after the agent stops needs Pi's `cacheWarming: "idle"`; it is turned on only when you agree (`--yes`, or the prompt). |
| `sources [--rebuild]` | Which tools' sessions are read, with how many sessions, the days they cover and their list-price cost. |
| `plan` | The plan, Pi's `cacheWarming`, and the last change. |
| `undo` / `reset` | Step back one change, or go back to before the first. Both put Pi's `cacheWarming` back when a change had set it. |

Recommendations stay within what Pi can do: Pi stops idle warming 30 minutes after a run, so a 5-minute cache gets at most 6 refreshes; when the replay's cheapest count is past that, the report says so. Pi cannot ask for OpenAI's 12-hour retention, so that is never recommended.

## Other tools' sessions

The report also reads other tools' local logs, so the cache replay can check warming against more than Pi's own history. Their models show as `<tool>/<model>` with a "from ..." label. They get no recommendations, because Pi cannot change another tool's cache.

| Tool | Folder | Per call | Turn off |
|---|---|---|---|
| Claude Code | `~/.claude/projects` (`CLAUDE_CONFIG_DIR`) | Measured, including the 5-minute and 1-hour write split | `PI_ANALYTICS_CLAUDE_CODE=0` |
| Codex CLI | `~/.codex/sessions`, `archived_sessions` (`CODEX_HOME`) | Measured; writes derived (input minus cached) for GPT-5.6 and later | `PI_ANALYTICS_CODEX=0` |
| Copilot app and CLI | `~/.copilot/session-state` (`COPILOT_HOME`) | Timing measured; prompt sizes estimated from each run's totals | `PI_ANALYTICS_COPILOT=0` |

All three are priced at the vendors' API list prices, so subscription sessions show what the API would have charged. ChatGPT's data export has no token counts, so it cannot be read.

## Files

Everything lives in `~/.pi/agent/pi-analytics/` (`PI_ANALYTICS_DIR` overrides it; `PI_CODING_AGENT_DIR` moves Pi's agent folder):

- `cache-plan.json`: per model (`provider/model`), the mode (`focus`, `keep-warm` with `idlePings`, `long`, or `auto` with `hourly` counts), plus a `default` entry and the change history used by undo.
- `sessions/<session id>.mode`: `{ "mode": "keep-warm", "changedAt": 1792947193283 }`, a mode picked for one session. It outranks the plan.
- `sessions/<session id>.status.json`: what the extension is doing for the session (mode and where it came from, retention, idle refresh limit and count, last request and refresh). The same object is sent as `pi-analytics:status` on `pi.events`.
- `analytics.sqlite`, `archive/`: the session index and copies of delegate sessions from the temp folder.

A session's mode is its `.mode` file, else the plan's entry for its model, else the plan's default, else `PI_ANALYTICS_CACHE_MODE` (or Pi Desktop's `PI_DESKTOP_CACHE_MODE`). With none of those, the extension leaves Pi alone. When a mode applies, it sets `PI_CACHE_RETENTION` before each request, fills in the vendor's cache lifetime for models Pi's catalog has none for (so Pi's warmer covers Copilot and OpenAI models), and answers Pi's idle `cache_warming_decision` events. It is meant to be the only extension answering those.
