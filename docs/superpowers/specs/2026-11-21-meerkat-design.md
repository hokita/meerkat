# Meerkat — design

Date: 2026-11-21. Status: approved by the user on 2026-11-21 (layout, scope, Mac-only access).
Items marked **(my call)** were decided by the implementer, not the user, and are open to correction.

## Intent

The user runs many Claude worker sessions in Herdr (https://herdr.dev) across many projects and finds it hard
to catch up on progress and next steps. Meerkat is a small local web app on the user's Mac that answers one
question at a glance: **what needs my attention?**

Success: open http://localhost:4321 and, within a second, see which sessions are finished or blocked, which are
still working (and for how long), and which are idle, kept live without reloading.

## Goals

- Three live columns, layout A "Needs you first" (picked by the user from the mockups at
  https://claude.ai/artifact/5SxcPADeFwceAWCBdcHYe1):
  1. **Needs attention**: `agent_status` is `done` or `blocked`.
  2. **Working**: `agent_status` is `working`, with elapsed time.
  3. **Idle**: `agent_status` is `idle`, plus `unknown` **(my call)**: `unknown` means Herdr can't classify the
     agent, and it shouldn't count as needing attention or as working.
- Each card shows: session name (Herdr agent `name`, or "(unnamed)"), app/repo, Herdr's terminal title, workspace
  id, a status pill, and time in status.
- Tapping a card opens its last ~40 lines of output, read on demand (only when opened).
- Live updates: Herdr status changes reach the browser without polling or reloading.
- Survives Herdr restarting: Meerkat reconnects and rebuilds its state by itself.
- Starts with `npm start` (build + serve), then the user opens http://localhost:4321.

## Non-goals

> Update 2026-11-22: sending input to agents is now built, narrowly. See `2026-11-22-reply-design.md`. The list below is the original.

- Phone or other-device access. **Considered and declined by the user on 2026-11-21** (see Approaches → Access).
- Sign-in or accounts.
- Sending prompts, keys, or any other input to agents; focusing, starting, closing, splitting or killing anything.
- Notifications (desktop, sound, push).
- Auto-start: no login item, no launchd agent, nothing installed globally.
- Deploys. CI only.
- Remote Herdr machines (`--machine`), named Herdr sessions other than the default socket.
- History or persistence across Meerkat restarts.

## Anti-goals (a failure even if it works)

- Meerkat changes anything in Herdr. It is strictly read-only. (Superseded 2026-11-22: Meerkat can now send three methods from the reply endpoint only; see `2026-11-22-reply-design.md`.)
- Another website open in the user's browser can read session names, paths or terminal output from Meerkat.
- Terminal output is rendered as HTML, or escape sequences reach the page and change how it looks.
- Meerkat quietly shows stale state as if it were live (for example, after Herdr went away).

## Constraints

- macOS only, Node **24.22.3** pinned (Volta `node` pin in `package.json`, `setup-node` in CI, checked by a
  `scripts/check-node-pins.sh` adapted from owlet). The local machine currently runs Node 24.16.0 through Volta;
  Volta will need to fetch 24.22.3 (outside the worktree, so ask the user first; see the plan).
- TypeScript, React + Vite, Vitest, ESLint (typescript-eslint recommended, react-hooks), Prettier with owlet's
  `.prettierrc` (`semi: false`, `singleQuote: true`, `trailingComma: es5`, `printWidth: 100`).
- Playwright e2e against a **fake Herdr socket**. CI never needs a real Herdr.
- GitHub Actions CI on pull requests: lint, type check, unit tests, node-pin check, e2e. No deploy workflows.
- User rules: no code comments at all (only build directives such as shebangs); never suppress lint or type errors;
  red/green TDD for every change.
- Development safety: never run bare `herdr` (opens the TUI), never `herdr server stop`, never call a mutating Herdr
  method, never kill processes Meerkat didn't start. Other workers run e2e in parallel, so report port clashes and
  don't kill anything.
- owlet (`~/ghq/github.com/hokita/owlet`) is a reference only. Never write there.

## Herdr protocol (verified 2026-11-21 against herdr 0.9.5, protocol 22)

Commands used (all read-only): `herdr --skill`, `herdr status`, `herdr api schema --json`, `herdr api snapshot`,
plus a Python probe that opened the socket directly and sent only `session.snapshot`, `events.subscribe` and
`agent.read`.

### Transport

- Unix socket at `~/.config/herdr/herdr.sock` (`herdr status` → `socket: /Users/hokita/.config/herdr/herdr.sock`).
- Newline-delimited JSON. Request: `{"id": "<string>", "method": "<name>", "params": {...}}` followed by `\n`.
- Success: `{"id": "...", "result": {...}}`. Error: `{"id": "...", "error": {"code": "...", "message": "..."}}`.
- For a one-shot request (`session.snapshot`, `agent.read`) the server writes one line and **closes the
  connection** (observed EOF). So: one connection per request.
- For `events.subscribe` the connection stays open and streams events.

### `session.snapshot` (what `herdr api snapshot` calls)

Request `{"id":"m1","method":"session.snapshot","params":{}}`. Response:

```json
{"id":"m1","result":{"type":"session_snapshot","snapshot":{
  "version":"0.9.5","protocol":22,
  "workspaces":[{"workspace_id":"wE","number":1,"label":"hamster","focused":false,"pane_count":2,"tab_count":1,
    "active_tab_id":"wE:t1","agent_status":"unknown",
    "worktree":{"repo_name":"hamster","checkout_path":"...","is_linked_worktree":false,"repo_root":"...","repo_key":"..."}}],
  "tabs":[...], "panes":[...], "layouts":[...],
  "agents":[{"pane_id":"w1H:p1","workspace_id":"w1H","tab_id":"w1H:t1","terminal_id":"...",
    "name":"meerkat-design","agent":"claude","agent_status":"working",
    "cwd":"/Users/hokita/.herdr/worktrees/meerkat/feat-initial-app","foreground_cwd":"...",
    "terminal_title":"...","terminal_title_stripped":"Meerkat design doc and implementation pl...",
    "focused":false,"revision":0,"state_change_seq":0,"completion_seq":217}],
  "focused_workspace_id":"wJ","focused_tab_id":"wJ:t1","focused_pane_id":"wJ:p1"}}}
```

Live data at the time: 19 workspaces, 21 panes, 12 agents. `name` is null for unnamed agents. Panes without an
agent appear in `panes` but not in `agents` (their `agent_status` is `unknown`). Meerkat shows **agents only**
**(my call)**: plain shells aren't sessions.

Statuses (`AgentStatus` enum): `idle`, `working`, `blocked`, `done`, `unknown`.

There is **no "status since" timestamp** in the snapshot. Meerkat records the time it first saw each status. After
Meerkat itself starts, a card's time shows as "≥ Nm" until a real transition is seen **(my call)**.

### `events.subscribe`

Request:

```json
{"id":"m5","method":"events.subscribe","params":{"subscriptions":[
  {"type":"pane.created"},{"type":"pane.closed"},{"type":"pane.updated"},{"type":"pane.exited"},
  {"type":"pane.agent_detected"},{"type":"workspace.created"},{"type":"workspace.renamed"},{"type":"workspace.closed"},
  {"type":"pane.agent_status_changed","pane_id":"w1H:p1"}, ...one per pane...]}}
```

- First line: `{"id":"m5","result":{"type":"subscription_started"}}`.
- Then one line per event. Observed live over 75 s:

  ```json
  {"data":{"agent":"claude","agent_status":"blocked","pane_id":"wJ:p1","workspace_id":"wJ"},"event":"pane.agent_status_changed"}
  ```

  Schema (`subscription_event` → `PaneAgentStatusChangedEvent`): required `pane_id`, `workspace_id`,
  `agent_status`; optional `agent`, `display_agent`, `title`, `state_labels`.
- **`pane.agent_status_changed` requires a `pane_id`.** Without one the server replies
  `{"error":{"code":"invalid_request","message":"invalid request: missing field `pane_id` ..."}}`. So Meerkat
  subscribes once per pane, all in one request, and re-subscribes when the set of panes changes.
- Lifecycle subscriptions (`pane.created`, `pane.closed`, `workspace.*`, ...) were accepted, but none fired during
  the probe, so their wire shape is **not verified live**. The schema's `event` envelope is
  `{"event":"<kind>","data":{"type":"<kind>",...}}` with underscore kinds (`pane_created`), while the observed
  status event uses dotted names. Design consequence: Meerkat treats **any line that isn't a status change as
  "topology may have changed"** and takes a fresh snapshot (debounced) and re-subscribes. It never depends on the
  details of lifecycle events.

### `agent.read`

Request `{"id":"m4","method":"agent.read","params":{"target":"w1H:p1","source":"recent_unwrapped","lines":40}}`
(`format` defaults to `text`, `strip_ansi` defaults to `true`; Meerkat sends both explicitly). Response:

```json
{"id":"m4","result":{"type":"pane_read","read":{"pane_id":"w1H:p1","workspace_id":"w1H","tab_id":"w1H:t1",
  "source":"recent_unwrapped","format":"text","text":"...","revision":0,"truncated":true}}}
```

On a pane without a live agent: `{"error":{"code":"agent_not_found","message":"agent target wE:p1 not found"}}`.
Meerkat maps that to "session closed".

### Allow-list

The Herdr client sends only these methods: `session.snapshot`, `events.subscribe`, `events.wait`, `agent.list`,
`agent.get`, `agent.read`. Anything else is refused **before any socket is opened**, and a unit test covers it with
every mutating method in the schema (`agent.prompt`, `agent.start`, `agent.send_keys`, `pane.close`,
`pane.split`, `pane.focus`, `server.stop`, ...). The full method list (109 methods; 102 in herdr 0.9.5's current schema) is in `herdr api schema --json`.

## Approaches

### Live updates: SSE vs WebSocket vs polling (my call: **SSE**)

| | SSE (`EventSource`) | WebSocket | Poll `herdr api snapshot` |
|---|---|---|---|
| Direction | server → browser, which is all Meerkat needs | both ways; the second way is unused | browser or server pulls |
| Reconnect | built into `EventSource` | hand-written | n/a |
| Dependencies | none (plain `node:http`) | `ws` or similar | none |
| Freshness | instant, driven by Herdr events | instant | as stale as the poll interval; spawns a CLI per poll |
| Cross-site risk | GET only; without CORS another origin can't read it | needs an `Origin` check on upgrade | same as SSE |

SSE fits a read-only, one-way feed with the least code. Polling stays inside the server as a safety net only:
the server re-takes a snapshot every 60 s to fix any drift **(my call)**.

What the server pushes **(my call)**: the **whole board** (every card) as one `board` event, debounced to about
100 ms, plus a `connection` event (`herdr: connected | disconnected`). At 50+ sessions the board is a few tens of
KB; sending the whole thing keeps the browser stateless and avoids diff bugs.

### Frontend: React vs a plain page (my call: **React + Vite**)

A plain page with `textContent` would be small, but three live columns, an output drawer, ticking elapsed times
and a disconnected state are easier to test with React Testing Library. React also escapes text by default,
which fits the "never render output as HTML" anti-goal. It's the user's usual stack (owlet).

### Access (user's decision: **Mac only**)

Options considered for phone access over Wi-Fi: (a) bind to the LAN with a secret key in the URL; (b) put it
behind Tailscale. **Declined by the user on 2026-11-21**, maybe later. Chosen:

- Bind `127.0.0.1:4321` only.
- Reject any request whose `Host` header isn't exactly `localhost:4321` or `127.0.0.1:4321` (stops DNS
  rebinding), with `421 Misdirected Request` **(my call for the status code)**.
- Send **no CORS headers**, so another website can't read responses even though it can reach localhost.
- Only `GET` is served; any other method gets `405` **(my call)**.
- Pane ids in URLs must match `^w[0-9A-Za-z]+:p[0-9A-Za-z]+$`, otherwise `400` **(my call)**.
- Tests cover the Host check, the absence of CORS headers, and the method check.

## How it works

### Shape (my call: one npm package)

```
package.json            one package: npm start = build + serve; volta node 24.22.3
src/server/             Node HTTP server (node:http, no framework)
  herdr/                socket client, allow-list, protocol types, snapshot/event parsing
  board.ts              pure state: snapshot + events + clock → cards and columns
  http.ts               routes, Host check, SSE
  main.ts               entry: wiring, reconnect loop
src/web/                React app (Vite)
e2e/                    Playwright specs + fake Herdr socket server
scripts/check-node-pins.sh
.github/workflows/ci.yml
```

owlet splits frontend, backend and e2e into three packages because they deploy separately. Meerkat ships as one
local process, so one package with one lockfile keeps `npm start` to a single command. The CI shape (lint, type
check, test, e2e jobs, `setup-node` pinned) is copied from owlet.

### Server

- **Herdr client**: `request(method, params)` checks the allow-list, opens a fresh socket connection, writes one
  line, and reads one line (with a timeout). `subscribe(paneIds)` keeps a connection open and yields parsed lines.
  The socket path defaults to `~/.config/herdr/herdr.sock`, overridable with `MEERKAT_HERDR_SOCKET` (for e2e).
- **Supervisor loop**: connect → snapshot → subscribe to all agent panes and lifecycle events → apply status
  events to the board. On a non-status event: debounced re-snapshot and re-subscribe. On EOF or error
  (`ECONNREFUSED`, `ENOENT`, Herdr restarting): mark disconnected, back off from 0.5 s doubling up to 5 s, retry
  forever. On reconnect, rebuild from a fresh snapshot.
- **Board** (pure, injectable clock): cards keyed by `pane_id` with name, repo, terminal title, workspace id,
  status, and `since`. Column from status. Sorting **(my call)**: Needs attention by longest waiting first;
  Working by longest running first; Idle by name.
- **App/repo** **(my call, refining "from cwd")**: the workspace's `worktree.repo_name` if present; otherwise,
  if `cwd` is under `~/.herdr/worktrees/<repo>/<branch>`, use `<repo>`; otherwise the last part of `cwd`. Using
  the last part of `cwd` alone would show `feat-initial-app` for Herdr worktrees.
- **HTTP routes**:
  - `GET /` and static assets: the built Vite app from `dist/web`.
  - `GET /api/events`: SSE. On connect, sends the current `connection` and `board`. Heartbeat comment every 15 s.
  - `GET /api/sessions/:paneId/output`: calls `agent.read` with `recent_unwrapped`, 40 lines, text,
    `strip_ansi: true`. Then removes any remaining C0/C1 control characters except `\n` and `\t`, and caps the
    text at 64 KB (keeping the end) **(my call)**. Returns `{text, truncated}`; `404` on `agent_not_found`;
    `503` when Herdr is disconnected.
- Port from `MEERKAT_PORT` (default 4321); the Host allow-list follows the port. If the port is busy, exit with a
  clear message and no fallback port **(my call)**: a different port would break the Host check and the
  bookmarked URL.

### Browser

- `EventSource('/api/events')` → board state. Three columns with count badges. Elapsed times tick every second
  on the client from `since`.
- Tap a card → a drawer fetches the output once, with a refresh button **(my call: no live tail)**. Output goes in
  a `<pre>` as a React text child, never `dangerouslySetInnerHTML`. If the card disappears from the board while
  the drawer is open, the drawer shows "Session closed", keeps the last text it fetched, and disables refresh.
- When Herdr is disconnected, a banner says so and the cards are dimmed (last known state, clearly marked
  stale). When the SSE stream drops, a banner says "Meerkat server not reachable".
- Empty state per column. Responsive enough for a narrow Mac window; no phone-specific work.

## Testing

- Unit (Vitest, node): allow-list refusal, line framing (split and merged chunks), snapshot/event parsing
  (including unknown fields and malformed lines), board reducer, repo naming, output sanitising and capping,
  Host check, no CORS headers, 405, pane-id validation, SSE framing, reconnect backoff (fake timers).
- Component (Vitest + jsdom + Testing Library): columns, card fields, "(unnamed)", elapsed time, drawer,
  session-closed state, banners, ANSI/HTML in output shown literally.
- e2e (Playwright, chromium): starts a scriptable **fake Herdr** Unix socket (in a temp dir) and Meerkat on a
  test port, then: board renders from the snapshot; a pushed status event moves a card between columns; the
  output drawer shows text; a fake Herdr restart shows the disconnected banner, then recovers; 60 sessions
  render; the fake records every method received, and the test asserts only allow-listed ones were sent.

## Left to the builder

Exact dependency versions (current at install time; check with `npm view`), CSS details within layout A,
debounce and timeout values within the ranges above, test port number for e2e.
