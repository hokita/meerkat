import net from 'node:net'
import { assertReadAllowed } from './allowlist.js'
import { LineSplitter } from './lines.js'

export class HerdrTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Herdr did not answer within ${timeoutMs} ms`)
    this.name = 'HerdrTimeoutError'
  }
}

export interface HerdrSubscription {
  readonly ended: Promise<Error | null>
  close(): void
}

export interface HerdrClient {
  request(method: string, params: object): Promise<string>
  subscribe(params: object, onLine: (line: string) => void): HerdrSubscription
}

export interface HerdrClientOptions {
  socketPath: string
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 5000

export function requestLine(
  socketPath: string,
  payload: string,
  timeoutMs: number
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath })
    const splitter = new LineSplitter()
    let settled = false
    const finish = (outcome: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      outcome()
    }
    const timer = setTimeout(
      () => finish(() => reject(new HerdrTimeoutError(timeoutMs))),
      timeoutMs
    )
    socket.on('connect', () => socket.write(payload))
    socket.on('data', (chunk) => {
      try {
        const [line] = splitter.push(chunk)
        if (line !== undefined) finish(() => resolve(line))
      } catch (error) {
        finish(() => reject(error))
      }
    })
    socket.on('error', (error) => finish(() => reject(error)))
    socket.on('close', () =>
      finish(() => reject(new Error('Herdr closed the connection without answering')))
    )
  })
}

export function createHerdrClient(opts: HerdrClientOptions): HerdrClient {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let counter = 0

  function nextRequest(method: string, params: object): string {
    counter += 1
    return `${JSON.stringify({ id: `meerkat-${counter}`, method, params })}\n`
  }

  return {
    async request(method, params) {
      assertReadAllowed(method)
      return requestLine(opts.socketPath, nextRequest(method, params), timeoutMs)
    },

    subscribe(params, onLine) {
      assertReadAllowed('events.subscribe')
      const payload = nextRequest('events.subscribe', params)
      const socket = net.createConnection({ path: opts.socketPath })
      const splitter = new LineSplitter()
      let settle: (value: Error | null) => void = () => undefined
      const ended = new Promise<Error | null>((resolve) => {
        settle = resolve
      })
      socket.on('connect', () => socket.write(payload))
      socket.on('data', (chunk) => {
        try {
          for (const line of splitter.push(chunk)) onLine(line)
        } catch (error) {
          socket.destroy()
          settle(error instanceof Error ? error : new Error(String(error)))
        }
      })
      socket.on('error', (error) => {
        socket.destroy()
        settle(error)
      })
      socket.on('close', () => settle(null))
      return {
        ended,
        close() {
          socket.destroy()
          settle(null)
        },
      }
    },
  }
}
