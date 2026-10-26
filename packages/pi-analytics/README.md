# pi-analytics

Cost and prompt-cache analytics for Pi sessions, outside Pi Desktop. It reads the same session files with the same code as the app's Analytics view, writes the same view as one HTML file, and tells you whether keep-warm pings would have saved money, and how many.

## Build and install

The package is built from Pi Desktop's sources:

```bash
npm install
npm run build:pi-analytics
pi install ./packages/pi-analytics      # /analytics and /start-session-analyzer in every Pi session
npm link ./packages/pi-analytics        # optional: the pi-analytics command on your PATH
```

## Commands

The same commands run as `pi-analytics <command>` in a terminal or `/analytics <command>` inside Pi.

| Command | What it does |
|---|---|
| `report [--range 7\|30\|90\|365\|all] [--out file] [--no-open] [--rebuild]` | Writes the HTML report to `~/.pi/agent/pi-analytics/reports/` and opens it. Default range: 30 days. |
| `cache [--range ...] [--details 5m\|30m]` | Per cache lifetime and model: the hit rate, the ping count that would have cost least, and what it saves a week. `--details` adds every count's cost, the per-model and per-break comparisons, and the last two weeks side by side. |
| `cache show` | The setting each model uses, whether Pi pings after you stop (cache warming), and `/away`. |
| `cache set <provider/model> <0-12\|long\|pi>` | Fix a model's idle pings (0 for none), or `long` for the longer cache with no pings; `pi` leaves the model to Pi. |
| `cache apply [--range ...]` | Sets every model to its recommended setting, except models with too little data to tell. |
| `warming on\|off` | Sets Pi's `cacheWarming` to `idle` (Pi may ping after you stop, which the pings need) or back to its default `streaming`. |
| `away [clear]` | No idle pings in any Pi chat until your next message in it, as `/away` does. |
| `sources [--rebuild]` | Which tools' sessions are read, with how many sessions, the days they cover and their list-price cost. |

| `sessions [--session <id>] [--no-open]` | Opens the live session page (below). |
| `serve [--port <port>]` | Runs the page's helper in the foreground, to see its log. |

Inside Pi, `/start-session-analyzer` opens the live session page on the current session, `/done` stops idle cache pings for the current chat, and `/away` stops them in every chat. Both hold only until your next message in a chat, so there is nothing to turn back on.

The cache analysis replays your calls the way Pi warms: a refresh at 90% of the lifetime, and no more than fit in the 30 minutes Pi keeps warming after a run (6 on a 5-minute cache, 1 on a 30-minute one). A model with fewer than 10 breaks longer than its lifetime borrows its group's answer.

## Live session page

Every Pi session that loads the package records what fills its context and what each call cost, the same snapshot Pi Desktop's Context panel shows. The session page lists every Pi session on the computer from the last week, running ones first, and shows the same board as the Context panel for the one you pick, updating as the session works. Sessions that ran without the package come from Pi's session log, with estimates where the snapshot would have had exact figures. The page only reads; nothing on it changes a session.

A small helper serves the page. The first `/start-session-analyzer` (or `pi-analytics sessions`, or Pi Desktop's pop-out button) starts it in the background, and it stops by itself after 10 minutes with no page open and no session running. It runs apart from any Pi session, so sessions starting and quitting never move it.

- It listens on 127.0.0.1 only, on port 47615 (`PI_ANALYTICS_PORT` changes it). When that port is taken by something else it picks a free one, and the command prints the address.
- The address carries a token kept in `server-token`, readable only by you; a request without it gets nothing. The page keeps working across helper restarts, and an open page reconnects by itself.
- A session's state comes from its process: the snapshot names the process and when it started, so a Pi that was killed shows as stopped within a couple of seconds, and a later process given the same id is not mistaken for it.
- Opened from Pi Desktop, the page follows the chat open in the app until you pick another session.

## Other tools' sessions

The report also reads other tools' local logs, so the cache replay can check warming against more than Pi's own history. Their models show as `<tool>/<model>` with a "from ..." label, analyzed like Pi's own for reference.

| Tool | Folder | Per call | Turn off |
|---|---|---|---|
| Claude Code | `~/.claude/projects` (`CLAUDE_CONFIG_DIR`) | Measured, including the 5-minute and 1-hour write split | `PI_ANALYTICS_CLAUDE_CODE=0` |
| Codex CLI | `~/.codex/sessions`, `archived_sessions` (`CODEX_HOME`) | Measured; writes derived (input minus cached) for GPT-5.6 and later | `PI_ANALYTICS_CODEX=0` |
| Copilot app and CLI | `~/.copilot/session-state` (`COPILOT_HOME`) | Timing measured; prompt sizes estimated from each run's totals | `PI_ANALYTICS_COPILOT=0` |

All three are priced at the vendors' API list prices, so subscription sessions show what the API would have charged. ChatGPT's data export has no token counts, so it cannot be read.

## Files

Everything lives in `~/.pi/agent/pi-analytics/` (`PI_ANALYTICS_DIR` overrides it; `PI_CODING_AGENT_DIR` moves Pi's agent folder):

- `context/<session id>.json`: the session's context snapshot (Pi Desktop names the same folder for its chats).
- `server.json`, `server-token`: where the page's helper listens, and its token. `desktop-focus.json`: the chat Pi Desktop has open, while its page follows it.
- `analytics.sqlite`, `archive/`: the session index and copies of delegate sessions from the temp folder.

- `cache-settings.json`: one fixed setting per model, `{"version":1,"models":{"anthropic/claude-haiku-5-5":6,"github-copilot/gpt-6-luna":"long"}}`. A number is how many idle pings Pi sends after you stop; `"long"` asks for the longer cache (`PI_CACHE_RETENTION=long` on that model's requests) and sends none. `away.json`: when `/away` was last used.

## Cache warming

The extension changes one thing: what Pi does after you stop, in a main chat whose model has a setting. Then it answers Pi's `cache_warming_decision` with exactly that many pings (reset by each request), or none for `0` and `long`. It also gives the model the vendor's cache lifetime when the model definition has none (GitHub Copilot models), since Pi warms only models with one. While the agent works, in subagents (sessions started by another Pi session), and for models without a setting, Pi decides by price as usual. Idle pings need Pi's `cacheWarming` set to `idle` (`pi-analytics warming on`); Pi still stops them 30 minutes after the last request.
