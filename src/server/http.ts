import { readFile, stat } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import type { HerdrClient } from './herdr/client.js'
import { readPrompt } from './read-prompt.js'
import type { Supervisor, SupervisorState } from './supervisor.js'

export interface HttpServerOptions {
  supervisor: Pick<Supervisor, 'current' | 'onChange' | 'card'>
  client: HerdrClient
  port: number
  token: string
  staticDir: string
  heartbeatMs?: number
}

export class PortInUseError extends Error {
  constructor(port: number) {
    super(
      `Port ${port} is already in use. Meerkat needs exactly this port; free it and run npm start again.`
    )
    this.name = 'PortInUseError'
  }
}

const DEFAULT_HEARTBEAT_MS = 15000
const PANE_ID = /^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/
const BASE64URL = /^[A-Za-z0-9_-]+$/
const TOKEN_META = /<meta name="meerkat-token" content="[^"]*"/
const REPLY_ROUTE = /^\/api\/sessions\/[^/]+\/reply$/
const OUTPUT_ROUTE = /^\/api\/sessions\/([^/]+)\/output$/

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

export function isAllowedHost(host: string | undefined, port: number): boolean {
  return host === `localhost:${port}` || host === `127.0.0.1:${port}`
}

function baseHeaders(contentType: string, cacheControl = 'no-store'): http.OutgoingHttpHeaders {
  return {
    'Content-Type': contentType,
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff',
  }
}

function htmlHeaders(): http.OutgoingHttpHeaders {
  return {
    ...baseHeaders(CONTENT_TYPES['.html'] ?? 'text/html'),
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "frame-ancestors 'none'",
  }
}

function withToken(html: Buffer, token: string): Buffer {
  if (!BASE64URL.test(token)) throw new Error('token is not base64url')
  return Buffer.from(
    html.toString('utf8').replace(TOKEN_META, `<meta name="meerkat-token" content="${token}"`)
  )
}

function sendText(
  res: http.ServerResponse,
  status: number,
  body: string,
  extra: http.OutgoingHttpHeaders = {}
): void {
  res.writeHead(status, { ...baseHeaders('text/plain; charset=utf-8'), ...extra })
  res.end(body)
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, baseHeaders('application/json; charset=utf-8'))
  res.end(JSON.stringify(body))
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function serveEvents(
  res: http.ServerResponse,
  supervisor: HttpServerOptions['supervisor'],
  heartbeatMs: number
): void {
  res.writeHead(200, baseHeaders('text/event-stream; charset=utf-8', 'no-cache'))
  const writeState = (state: SupervisorState): void => {
    res.write(`event: board\ndata: ${JSON.stringify(state.board)}\n\n`)
  }
  const initial = supervisor.current()
  res.write('retry: 2000\n')
  res.write(`event: connection\ndata: ${JSON.stringify({ herdr: initial.herdr })}\n\n`)
  writeState(initial)
  let lastHerdr = initial.herdr
  const unsubscribe = supervisor.onChange((state) => {
    if (state.herdr !== lastHerdr) {
      lastHerdr = state.herdr
      res.write(`event: connection\ndata: ${JSON.stringify({ herdr: state.herdr })}\n\n`)
    }
    writeState(state)
  })
  const heartbeat = setInterval(() => res.write(': ping\n\n'), heartbeatMs)
  res.on('close', () => {
    unsubscribe()
    clearInterval(heartbeat)
  })
}

async function serveOutput(
  res: http.ServerResponse,
  encodedId: string,
  opts: HttpServerOptions
): Promise<void> {
  const target = decodeSegment(encodedId)
  if (target === null || !PANE_ID.test(target)) {
    sendJson(res, 400, { error: 'invalid_pane_id' })
    return
  }
  if (opts.supervisor.current().herdr !== 'connected') {
    sendJson(res, 503, { error: 'herdr_unreachable' })
    return
  }
  try {
    const result = await readPrompt(opts, target)
    if (result === 'gone') {
      sendJson(res, 404, { error: 'session_closed' })
      return
    }
    sendJson(res, 200, result)
  } catch {
    sendJson(res, 502, { error: 'herdr_error' })
  }
}

async function readFileIfPresent(file: string): Promise<Buffer | null> {
  try {
    if (!(await stat(file)).isFile()) return null
    return await readFile(file)
  } catch {
    return null
  }
}

function looksLikeFile(pathname: string): boolean {
  const last = pathname.split('/').pop() ?? ''
  return last.includes('.')
}

async function serveStatic(
  res: http.ServerResponse,
  pathname: string,
  staticDir: string,
  token: string
): Promise<void> {
  const decoded = decodeSegment(pathname)
  if (decoded === null) {
    sendText(res, 400, 'Bad Request')
    return
  }
  const root = path.resolve(staticDir)
  const resolved = path.resolve(root, '.' + decoded)
  const inside = resolved === root || resolved.startsWith(root + path.sep)
  const body = inside && decoded !== '/' ? await readFileIfPresent(resolved) : null
  if (body !== null) {
    const extension = path.extname(resolved).toLowerCase()
    if (extension === '.html') {
      res.writeHead(200, htmlHeaders())
      res.end(resolved === path.join(root, 'index.html') ? withToken(body, token) : body)
      return
    }
    const type = CONTENT_TYPES[extension] ?? 'application/octet-stream'
    res.writeHead(200, baseHeaders(type))
    res.end(body)
    return
  }
  if (decoded !== '/' && looksLikeFile(decoded)) {
    sendText(res, 404, 'Not Found')
    return
  }
  const index = await readFileIfPresent(path.join(root, 'index.html'))
  if (index === null) {
    sendText(res, 404, 'Not Found')
    return
  }
  res.writeHead(200, htmlHeaders())
  res.end(withToken(index, token))
}

export function createHttpServer(opts: HttpServerOptions): http.Server {
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!isAllowedHost(req.headers.host, opts.port)) {
      sendText(res, 421, 'Misdirected Request')
      return
    }
    const pathname = (req.url ?? '/').split('?')[0] ?? '/'
    if (req.method !== 'GET') {
      const allow = REPLY_ROUTE.test(pathname) ? 'POST' : 'GET'
      sendText(res, 405, 'Method Not Allowed', { Allow: allow })
      return
    }
    if (pathname === '/api/events') {
      serveEvents(res, opts.supervisor, heartbeatMs)
      return
    }
    const output = OUTPUT_ROUTE.exec(pathname)
    if (output !== null) {
      await serveOutput(res, output[1] ?? '', opts)
      return
    }
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    await serveStatic(res, pathname, opts.staticDir, opts.token)
  }

  return http.createServer({ requireHostHeader: false }, (req, res) => {
    route(req, res).catch(() => {
      if (res.headersSent) res.destroy()
      else sendText(res, 500, 'Internal Server Error')
    })
  })
}

export function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      reject(error.code === 'EADDRINUSE' ? new PortInUseError(port) : error)
    }
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })
}
