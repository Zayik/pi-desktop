# pi-analytics

Cost and prompt-cache analytics for Pi sessions, outside Pi Desktop. It reads the same session files with the same code as the app's Analytics view, writes the same view as one HTML file, and can put its cache recommendations into effect (and take them back).

## Build and install

The package is built from Pi Desktop's sources:

```bash
npm install
npm run build:pi-analytics
pi install ./packages/pi-analytics      # /analytics, /start-session-analyzer and the cache plan in every Pi session
npm link ./packages/pi-analytics        # optional: the pi-analytics command on your PATH
```

## Commands

The same commands run as `pi-analytics <command>` in a terminal or `/analytics <command>` inside Pi.

| Command | What it does |
|---|---|
| `report [--range 7\|30\|90\|365\|all] [--out file] [--no-open] [--rebuild]` | Writes the HTML report to `~/.pi/agent/pi-analytics/reports/` and opens it. Default range: 30 days. |
| `recommend [--range ...]` | Numbered cache settings that would have cost less, with the saving per week. |
| `apply <number>... \| all [--yes]` | Puts them into the cache plan. A setting that refreshes the cache after the agent stops needs Pi's `cacheWarming: "idle"`; it is turned on only when you agree (`--yes`, or the prompt). |
| `plan` | The plan, Pi's `cacheWarming`, and the last change. |
| `undo` / `reset` | Step back one change, or go back to before the first. Both put Pi's `cacheWarming` back when a change had set it. |

| `sessions [--session <id>] [--no-open]` | Opens the live session page (below). |
| `serve [--port <port>]` | Runs the page's helper in the foreground, to see its log. |

Inside Pi, `/start-session-analyzer` opens the live session page on the current session.

Recommendations stay within what Pi can do: Pi stops idle warming 30 minutes after a run, so a 5-minute cache gets at most 6 refreshes; when the replay's cheapest count is past that, the report says so. Pi cannot ask for OpenAI's 12-hour retention, so that is never recommended.

## Live session page

Every Pi session that loads the package records what fills its context and what each call cost, the same snapshot Pi Desktop's Context panel shows. The session page lists every Pi session on the computer from the last week, running ones first, and shows the same board as the Context panel for the one you pick, updating as the session works. Sessions that ran without the package come from Pi's session log, with estimates where the snapshot would have had exact figures. The page only reads; nothing on it changes a session.

A small helper serves the page. The first `/start-session-analyzer` (or `pi-analytics sessions`, or Pi Desktop's pop-out button) starts it in the background, and it stops by itself after 10 minutes with no page open and no session running. It runs apart from any Pi session, so sessions starting and quitting never move it.

- It listens on 127.0.0.1 only, on port 47615 (`PI_ANALYTICS_PORT` changes it). When that port is taken by something else it picks a free one, and the command prints the address.
- The address carries a token kept in `server-token`, readable only by you; a request without it gets nothing. The page keeps working across helper restarts, and an open page reconnects by itself.
- A session's state comes from its process: the snapshot names the process and when it started, so a Pi that was killed shows as stopped within a couple of seconds, and a later process given the same id is not mistaken for it.
- Opened from Pi Desktop, the page follows the chat open in the app until you pick another session.

## Files

Everything lives in `~/.pi/agent/pi-analytics/` (`PI_ANALYTICS_DIR` overrides it; `PI_CODING_AGENT_DIR` moves Pi's agent folder):

- `cache-plan.json`: per model (`provider/model`), the mode (`focus`, `keep-warm` with `idlePings`, `long`, or `auto` with `hourly` counts), plus a `default` entry and the change history used by undo.
- `sessions/<session id>.mode`: `{ "mode": "keep-warm", "changedAt": 1792947193283 }`, a mode picked for one session. It outranks the plan.
- `sessions/<session id>.status.json`: what the extension is doing for the session (mode and where it came from, retention, idle refresh limit and count, last request and refresh). The same object is sent as `pi-analytics:status` on `pi.events`.
- `context/<session id>.json`: the session's context snapshot (Pi Desktop names the same folder for its chats).
- `server.json`, `server-token`: where the page's helper listens, and its token. `desktop-focus.json`: the chat Pi Desktop has open, while its page follows it.
- `analytics.sqlite`, `archive/`: the session index and copies of delegate sessions from the temp folder.

A session's mode is its `.mode` file, else the plan's entry for its model, else the plan's default, else `PI_ANALYTICS_CACHE_MODE` (or Pi Desktop's `PI_DESKTOP_CACHE_MODE`). With none of those, the extension leaves Pi alone. When a mode applies, it sets `PI_CACHE_RETENTION` before each request, fills in the vendor's cache lifetime for models Pi's catalog has none for (so Pi's warmer covers Copilot and OpenAI models), and answers Pi's idle `cache_warming_decision` events. It is meant to be the only extension answering those.
