import { randomBytes, timingSafeEqual } from 'node:crypto'
import type http from 'node:http'

export type GuardResult = 'ok' | 'forbidden' | 'unsupported_media'

export function createToken(): string {
  return randomBytes(32).toString('base64url')
}

function tokenMatches(given: string | undefined, token: string): boolean {
  if (given === undefined) return false
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

function originMatches(
  origin: string | undefined,
  host: string | undefined,
  port: number
): boolean {
  if (origin === undefined || host === undefined) return false
  const allowed = [`http://localhost:${port}`, `http://127.0.0.1:${port}`]
  return allowed.includes(origin) && origin === `http://${host}`
}

function isJson(contentType: string | undefined): boolean {
  if (contentType === undefined) return false
  const [type, ...params] = contentType.split(';').map((part) => part.trim().toLowerCase())
  if (type !== 'application/json') return false
  return params.every((param) => param === 'charset=utf-8')
}

export function checkReplyRequest(
  req: Pick<http.IncomingMessage, 'headers'>,
  token: string,
  port: number
): GuardResult {
  const { headers } = req
  if (!originMatches(headers.origin, headers.host, port)) return 'forbidden'
  const site = headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin') return 'forbidden'
  const given = headers['x-meerkat-token']
  if (!tokenMatches(typeof given === 'string' ? given : undefined, token)) return 'forbidden'
  return isJson(headers['content-type']) ? 'ok' : 'unsupported_media'
}
