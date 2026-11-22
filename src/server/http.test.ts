import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeSnapshot, startFakeHerdr, type FakeHerdr } from '../../test-support/fake-herdr.js'
import type { BoardView, Card } from '../shared/types.js'
import { createToken } from './guard.js'
import { createHerdrClient } from './herdr/client.js'
import { createHttpServer, isAllowedHost, listen, PortInUseError } from './http.js'
import type { SupervisorState } from './supervisor.js'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

const emptyBoard: BoardView = { attention: [], working: [], idle: [] }

function boardWith(paneId: string): BoardView {
  return {
    attention: [
      {
        paneId,
        workspaceId: 'w1',
        name: null,
        repo: 'repo',
        title: null,
        status: 'blocked',
        since: 1,
        sinceIsLowerBound: false,
        progress: null,
        agent: 'claude',
        terminalId: 't1',
        statusEpoch: 0,
        lastReply: null,
      },
    ],
    working: [],
    idle: [],
  }
}

interface Stub {
  state: SupervisorState
  listeners: Set<(state: SupervisorState) => void>
  current(): SupervisorState
  card(paneId: string): Card | undefined
  onChange(listener: (state: SupervisorState) => void): () => void
  emit(state: SupervisorState): void
}

function stubSupervisor(state: SupervisorState): Stub {
  const stub: Stub = {
    state,
    listeners: new Set(),
    current: () => stub.state,
    card: (paneId) => {
      const found = [
        ...stub.state.board.attention,
        ...stub.state.board.working,
        ...stub.state.board.idle,
      ]
      return found.find((card) => card.paneId === paneId)
    },
    onChange(listener) {
      stub.listeners.add(listener)
      return () => {
        stub.listeners.delete(listener)
      }
    },
    emit(next) {
      stub.state = next
      for (const listener of [...stub.listeners]) listener(next)
    },
  }
  return stub
}

interface Harness {
  port: number
  fake: FakeHerdr
  stub: Stub
  staticParent: string
  token: string
}

async function harness(
  opts: { state?: SupervisorState; heartbeatMs?: number } = {}
): Promise<Harness> {
  const fake = await startFakeHerdr({
    snapshot: fakeSnapshot({ agents: [] }),
    reads: { 'w1H:p1': 'hello \u001b[31mred\u001b[0m world' },
  })
  const staticParent = await mkdtemp(join(tmpdir(), 'mk-static-'))
  const staticDir = join(staticParent, 'public')
  await mkdir(join(staticDir, 'assets'), { recursive: true })
  await writeFile(
    join(staticDir, 'index.html'),
    '<!doctype html><meta name="meerkat-token" content=""><title>m</title>'
  )
  await writeFile(join(staticDir, 'assets', 'a.js'), 'export {}')
  await writeFile(join(staticParent, 'package.json'), '{"secret":true}')
  const stub = stubSupervisor(opts.state ?? { herdr: 'connected', board: emptyBoard })
  const probe = http.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  const token = createToken()
  const real = createHttpServer({
    supervisor: stub,
    client: createHerdrClient({ socketPath: fake.socketPath, timeoutMs: 500 }),
    port,
    token,
    staticDir,
    heartbeatMs: opts.heartbeatMs,
  })
  await new Promise<void>((resolve) => real.listen(port, '127.0.0.1', () => resolve()))
  cleanups.push(async () => {
    real.closeAllConnections()
    await new Promise<void>((resolve) => real.close(() => resolve()))
    await fake.stop()
    await rm(staticParent, { recursive: true, force: true })
  })
  return { port, fake, stub, staticParent, token }
}

interface Reply {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

function get(
  h: Harness,
  path: string,
  opts: { method?: string; host?: string | null; headers?: http.OutgoingHttpHeaders } = {}
): Promise<Reply> {
  const headers: http.OutgoingHttpHeaders = { ...opts.headers }
  if (opts.host !== null) headers['Host'] = opts.host ?? `localhost:${h.port}`
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: h.port, path, method: opts.method ?? 'GET', headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        )
      }
    )
    req.on('error', reject)
    req.end()
  })
}

interface Stream {
  res: http.IncomingMessage
  text(): string
  until(fragment: string): Promise<string>
  close(): void
}

function openStream(h: Harness, path = '/api/events'): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: h.port, path, headers: { Host: `localhost:${h.port}` } },
      (res) => {
        let buffer = ''
        const waiters: { fragment: string; resolve: (text: string) => void }[] = []
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          buffer += chunk
          for (const waiter of [...waiters]) {
            if (buffer.includes(waiter.fragment)) {
              waiters.splice(waiters.indexOf(waiter), 1)
              waiter.resolve(buffer)
            }
          }
        })
        const stream: Stream = {
          res,
          text: () => buffer,
          until(fragment) {
            if (buffer.includes(fragment)) return Promise.resolve(buffer)
            return new Promise((done) => waiters.push({ fragment, resolve: done }))
          },
          close() {
            req.destroy()
          },
        }
        cleanups.push(async () => stream.close())
        resolve(stream)
      }
    )
    req.on('error', reject)
    req.end()
  })
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('condition not met')
}

describe('isAllowedHost', () => {
  it('accepts only localhost and 127.0.0.1 with the port', () => {
    expect(isAllowedHost('localhost:4321', 4321)).toBe(true)
    expect(isAllowedHost('127.0.0.1:4321', 4321)).toBe(true)
    for (const host of [
      'localhost',
      'localhost:4322',
      'evil.example:4321',
      '127.0.0.1.evil.example:4321',
      '[::1]:4321',
      'LOCALHOST:4321',
      undefined,
    ]) {
      expect(isAllowedHost(host, 4321)).toBe(false)
    }
  })
})

describe('host check and method guard', () => {
  it('answers 421 for a foreign Host and 200 for localhost', async () => {
    const h = await harness()
    const foreign = await get(h, '/', { host: 'evil.example:4321' })
    expect(foreign.status).toBe(421)
    expect(foreign.body).not.toContain('<title>')
    const ok = await get(h, '/')
    expect(ok.status).toBe(200)
    expect(ok.headers['content-type']).toContain('text/html')
  })

  it('answers 421 with nosniff when the Host header is missing', async () => {
    const h = await harness()
    for (const request of [
      'GET / HTTP/1.0\r\n\r\n',
      'GET / HTTP/1.1\r\nConnection: close\r\n\r\n',
    ]) {
      const raw = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(h.port, '127.0.0.1', () => socket.write(request))
        let data = ''
        socket.setEncoding('utf8')
        socket.on('data', (chunk: string) => (data += chunk))
        socket.on('end', () => resolve(data))
        socket.on('error', reject)
      })
      expect(raw.startsWith('HTTP/1.1 421')).toBe(true)
      expect(raw.toLowerCase()).toContain('x-content-type-options: nosniff')
      expect(raw.toLowerCase()).toContain('cache-control: no-store')
    }
  })

  it('checks the Host before the output route reaches Herdr', async () => {
    const h = await harness()
    const reply = await get(h, '/api/sessions/w1H:p1/output', { host: 'evil.example:4321' })
    expect(reply.status).toBe(421)
    expect(h.fake.received).toEqual([])
  })

  it('never sends CORS headers and always sends nosniff', async () => {
    const h = await harness()
    const headers = { Origin: 'https://evil.example' }
    const replies = [
      await get(h, '/', { headers }),
      await get(h, '/api/sessions/w1H:p1/output', { headers }),
      await get(h, '/api/nothing', { headers }),
      await get(h, '/', { host: 'evil.example:4321', headers }),
      await get(h, '/api/events', { method: 'OPTIONS', headers }),
    ]
    const stream = await openStream(h)
    for (const reply of replies) {
      expect(Object.keys(reply.headers).filter((k) => k.startsWith('access-control-'))).toEqual([])
      expect(reply.headers['x-content-type-options']).toBe('nosniff')
      expect(reply.headers['cache-control']).toBe('no-store')
    }
    expect(Object.keys(stream.res.headers).filter((k) => k.startsWith('access-control-'))).toEqual(
      []
    )
  })

  it('answers 405 with Allow: GET for other methods', async () => {
    const h = await harness()
    const options = await get(h, '/api/events', { method: 'OPTIONS' })
    expect(options.status).toBe(405)
    expect(options.headers['allow']).toBe('GET')
    const post = await get(h, '/api/sessions/w1:p1/output', { method: 'POST' })
    expect(post.status).toBe(405)
    expect(post.headers['allow']).toBe('GET')
    expect(h.fake.received).toEqual([])
  })
})

describe('GET /api/events', () => {
  it('streams connection then board, then updates, and unsubscribes on close', async () => {
    const h = await harness()
    const stream = await openStream(h)
    expect(stream.res.headers['content-type']).toBe('text/event-stream; charset=utf-8')
    expect(stream.res.headers['cache-control']).toBe('no-cache')
    const first = await stream.until('event: board')
    expect(first.startsWith('retry: 2000\n')).toBe(true)
    expect(first).toContain('event: connection\ndata: {"herdr":"connected"}\n\n')
    expect(first).toContain(`event: board\ndata: ${JSON.stringify(emptyBoard)}\n\n`)
    expect(first.indexOf('event: connection')).toBeLessThan(first.indexOf('event: board'))

    const next = boardWith('w9:p1')
    h.stub.emit({ herdr: 'connected', board: next })
    const after = await stream.until('w9:p1')
    expect(after).toContain(`event: board\ndata: ${JSON.stringify(next)}\n\n`)

    expect(h.stub.listeners.size).toBe(1)
    stream.close()
    await waitFor(() => h.stub.listeners.size === 0)
  })

  it('reports a disconnected Herdr on the connection event', async () => {
    const h = await harness({ state: { herdr: 'disconnected', board: emptyBoard } })
    const stream = await openStream(h)
    expect(await stream.until('event: board')).toContain('data: {"herdr":"disconnected"}')
  })

  it('reports a connecting Herdr on the connection event', async () => {
    const h = await harness({ state: { herdr: 'connecting', board: emptyBoard } })
    const stream = await openStream(h)
    expect(await stream.until('event: board')).toContain('data: {"herdr":"connecting"}')
  })

  it('sends heartbeat comments', async () => {
    const h = await harness({ heartbeatMs: 20 })
    const stream = await openStream(h)
    await stream.until(': ping\n\n')
  })
})

function outputHarness(paneId: string, status: 'blocked' | 'working' | 'idle' = 'blocked') {
  const board = boardWith(paneId)
  const card = board.attention[0] as Card
  return harness({
    state: {
      herdr: 'connected',
      board: { attention: [], working: [], idle: [{ ...card, status }] },
    },
  })
}

function screen(name: string): string {
  return readFileSync(new URL(`../../test-support/screens/${name}`, import.meta.url), 'utf8')
}

describe('GET /api/sessions/:id/output', () => {
  it('reads the pane through Herdr and returns sanitised text with a prompt', async () => {
    const h = await outputHarness('w1H:p1', 'idle')
    const reply = await get(h, '/api/sessions/w1H:p1/output')
    expect(reply.status).toBe(200)
    expect(reply.headers['content-type']).toContain('application/json')
    expect(JSON.parse(reply.body)).toEqual({
      text: 'hello red world',
      truncated: false,
      prompt: { kind: 'unrecognized', fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) },
    })
    expect(h.fake.received).toEqual([
      {
        method: 'agent.read',
        params: {
          target: 'w1H:p1',
          source: 'recent_unwrapped',
          lines: 120,
          format: 'text',
          strip_ansi: true,
        },
      },
    ])
  })

  it('returns a recognized permission prompt with at most 40 lines', async () => {
    const h = await outputHarness('w2:p1')
    h.fake.setRead('w2:p1', screen('permission-bash.txt'))
    const reply = await get(h, '/api/sessions/w2:p1/output')
    const body = JSON.parse(reply.body) as {
      text: string
      prompt: { kind: string; fingerprint: string }
    }
    expect(body.prompt.kind).toBe('permission')
    expect(body.prompt.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(body.text.split('\n').length).toBeLessThanOrEqual(40)
  })

  it('returns no prompt for a working pane', async () => {
    const h = await outputHarness('w2:p1', 'working')
    h.fake.setRead('w2:p1', screen('permission-bash.txt'))
    const reply = await get(h, '/api/sessions/w2:p1/output')
    expect((JSON.parse(reply.body) as { prompt: unknown }).prompt).toEqual({ kind: 'none' })
  })

  it('marks clipped output as truncated', async () => {
    const h = await outputHarness('w2:p1', 'working')
    h.fake.setRead('w2:p1', 'x'.repeat(70000))
    const reply = await get(h, '/api/sessions/w2:p1/output')
    const body = JSON.parse(reply.body) as { text: string; truncated: boolean }
    expect(body.truncated).toBe(true)
    expect(body.text.length).toBe(65536)
  })

  it('accepts a percent-encoded pane id', async () => {
    const h = await outputHarness('w1H:p1')
    const reply = await get(h, '/api/sessions/w1H%3Ap1/output')
    expect(reply.status).toBe(200)
  })

  it('answers 404 session_closed for an unknown pane', async () => {
    const h = await harness()
    const reply = await get(h, '/api/sessions/w7:p7/output')
    expect(reply.status).toBe(404)
    expect(JSON.parse(reply.body)).toEqual({ error: 'session_closed' })
  })

  it('answers 503 without calling Herdr when disconnected', async () => {
    const h = await harness({ state: { herdr: 'disconnected', board: emptyBoard } })
    const reply = await get(h, '/api/sessions/w1H:p1/output')
    expect(reply.status).toBe(503)
    expect(h.fake.received).toEqual([])
  })

  it('answers 503 without calling Herdr while still connecting', async () => {
    const h = await harness({ state: { herdr: 'connecting', board: emptyBoard } })
    const reply = await get(h, '/api/sessions/w1H:p1/output')
    expect(reply.status).toBe(503)
    expect(h.fake.received).toEqual([])
  })

  it('answers 400 without calling Herdr for invalid pane ids', async () => {
    const h = await harness()
    for (const path of [
      '/api/sessions/..%2Fetc/output',
      '/api/sessions/w1:p1;x/output',
      '/api/sessions/%E0%A4%A/output',
      '/api/sessions/w1/output',
    ]) {
      expect((await get(h, path)).status).toBe(400)
    }
    expect(h.fake.received).toEqual([])
  })

  it('answers 502 herdr_error when Herdr is unreachable', async () => {
    const h = await outputHarness('w1H:p1')
    await h.fake.stop()
    const reply = await get(h, '/api/sessions/w1H:p1/output')
    expect(reply.status).toBe(502)
    expect(JSON.parse(reply.body)).toEqual({ error: 'herdr_error' })
  })
})

describe('static files and fallback', () => {
  it('serves assets with a content type', async () => {
    const h = await harness()
    const reply = await get(h, '/assets/a.js')
    expect(reply.status).toBe(200)
    expect(reply.headers['content-type']).toContain('text/javascript')
    expect(reply.body).toBe('export {}')
  })

  it('refuses traversal out of the static directory', async () => {
    const h = await harness()
    expect((await get(h, '/assets/../../package.json')).status).toBe(404)
    expect((await get(h, '/%2e%2e/package.json')).status).toBe(404)
    expect((await get(h, '/..%2fpackage.json')).status).toBe(404)
    expect((await get(h, '/%00.js')).status).toBe(404)
    expect((await get(h, '/%E0%A4%A')).status).toBe(400)
  })

  it('falls back to index.html for app routes but not files or the API', async () => {
    const h = await harness()
    const route = await get(h, '/some/route')
    expect(route.status).toBe(200)
    expect(route.body).toContain('<title>m</title>')
    expect((await get(h, '/missing.js')).status).toBe(404)
    const api = await get(h, '/api/nothing')
    expect(api.status).toBe(404)
    expect(api.headers['content-type']).toContain('application/json')
  })
})

describe('guard headers and token', () => {
  it('writes the token into index.html on / and on the SPA fallback', async () => {
    const h = await harness()
    for (const route of ['/', '/some/route']) {
      const reply = await get(h, route)
      expect(reply.body).toContain(`<meta name="meerkat-token" content="${h.token}"`)
    }
  })

  it('sends frame-blocking headers on every HTML response', async () => {
    const h = await harness()
    for (const route of ['/', '/some/route']) {
      const reply = await get(h, route)
      expect(reply.headers['x-frame-options']).toBe('DENY')
      expect(reply.headers['content-security-policy']).toBe("frame-ancestors 'none'")
      expect(reply.headers['x-content-type-options']).toBe('nosniff')
      expect(reply.headers['cache-control']).toBe('no-store')
    }
  })

  it('does not put the token in non-HTML responses', async () => {
    const h = await harness()
    const reply = await get(h, '/assets/a.js')
    expect(reply.body).not.toContain(h.token)
    expect(reply.headers['x-frame-options']).toBeUndefined()
  })

  it('answers OPTIONS on the reply route with 405, Allow: POST and no CORS headers', async () => {
    const h = await harness()
    const reply = await get(h, '/api/sessions/w1H:p1/reply', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-meerkat-token,content-type',
      },
    })
    expect(reply.status).toBe(405)
    expect(reply.headers['allow']).toBe('POST')
    expect(Object.keys(reply.headers).filter((k) => k.startsWith('access-control-'))).toEqual([])
    expect(h.fake.received).toEqual([])
  })

  it('never logs the token', async () => {
    const calls: unknown[][] = []
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) => {
      const original = console[name]
      console[name] = (...args: unknown[]) => void calls.push(args)
      return () => {
        console[name] = original
      }
    })
    try {
      const h = await harness()
      await get(h, '/')
      expect(JSON.stringify(calls)).not.toContain(h.token)
    } finally {
      for (const restore of spies) restore()
    }
  })
})

describe('listen', () => {
  it('rejects with PortInUseError when the port is taken', async () => {
    const holder = http.createServer()
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', () => resolve()))
    cleanups.push(() => new Promise<void>((resolve) => holder.close(() => resolve())))
    const port = (holder.address() as AddressInfo).port
    const other = http.createServer()
    await expect(listen(other, port)).rejects.toThrow(PortInUseError)
    await expect(listen(other, port)).rejects.toThrow(
      `Port ${port} is already in use. Meerkat needs exactly this port; free it and run npm start again.`
    )
  })

  it('binds to 127.0.0.1', async () => {
    const server = http.createServer()
    await listen(server, 0)
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    expect((server.address() as AddressInfo).address).toBe('127.0.0.1')
  })
})
