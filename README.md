# Meerkat

A small local web app that answers one question at a glance: what needs my attention? It shows your
[Herdr](https://herdr.dev) agent sessions in three live columns (Needs attention, Working, Idle) and
opens the last lines of a session's output on demand.

## Run

Meerkat needs Node 24.22.3, pinned with [Volta](https://volta.sh) in `package.json`.

```sh
npm install
npm start
```

Then open http://localhost:4321. Herdr must be running for the board to fill; until Meerkat can reach
it, the page shows `Herdr is not reachable — showing last known state`.

Each card shows the session's latest update and how long ago it changed.

| Variable               | Default                      | Meaning                       |
| ---------------------- | ---------------------------- | ----------------------------- |
| `MEERKAT_PORT`         | `4321`                       | Port, an integer from 1-65535 |
| `MEERKAT_HERDR_SOCKET` | `~/.config/herdr/herdr.sock` | Herdr API socket              |

## Promises

Read-only. The Herdr client sends only `session.snapshot`, `events.subscribe`, `events.wait`,
`agent.list`, `agent.get` and `agent.read`. Any other method is refused before a socket is opened.
A unit test tries every mutating method (`agent.prompt`, `agent.start`, `agent.send_keys`,
`pane.close`, `pane.split`, `pane.focus`, `server.stop`, ...).

Localhost only, Mac only:

- The server binds `127.0.0.1` and nothing else.
- A request whose `Host` header is not exactly `localhost:<port>` or `127.0.0.1:<port>` gets
  `421 Misdirected Request`, which stops DNS rebinding.
- No CORS headers are ever sent, so other websites cannot read responses.
- Only `GET` is served; anything else gets `405`.

Tests in `src/server/http.test.ts` cover the Host check, the absence of CORS headers and the method
check. The allow-list tests live beside the Herdr client in `src/server/herdr/`.

Not included: phone access, sign-in, sending input to agents, notifications, auto-start, deploys.

## Develop

```sh
npm test
npm run lint
npm run typecheck
npm run format:check
npm run check:node-pins
npm run test:e2e
```

`npm run test:e2e` drives Chromium through Playwright on port 43219; install the browser once with
`npx playwright install chromium`. Tests use a fake Herdr and never touch the real socket.
