# Meerkat

A small local web app that answers one question at a glance: what needs my attention? It shows your
[Herdr](https://herdr.dev) agent sessions in three live columns (Needs attention, Working, Idle) and
opens the last lines of a session's output on demand.

## Run

```sh
npm install
npm start
```

Then open http://localhost:4321.

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
```

Tests use a fake Herdr and never touch the real socket.
