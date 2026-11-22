import type http from 'node:http'
import { describe, expect, it } from 'vitest'
import { checkReplyRequest, createToken } from './guard.js'

const TOKEN = createToken()
const PORT = 4321

function request(
  headers: Record<string, string | undefined>
): Pick<http.IncomingMessage, 'headers'> {
  return {
    headers: {
      host: `localhost:${PORT}`,
      origin: `http://localhost:${PORT}`,
      'sec-fetch-site': 'same-origin',
      'x-meerkat-token': TOKEN,
      'content-type': 'application/json',
      ...headers,
    },
  }
}

describe('createToken', () => {
  it('makes distinct base64url tokens of 32 bytes', () => {
    const a = createToken()
    const b = createToken()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
})

describe('checkReplyRequest', () => {
  it('accepts a same-origin request with the token and JSON', () => {
    expect(checkReplyRequest(request({}), TOKEN, PORT)).toBe('ok')
    expect(
      checkReplyRequest(
        request({
          host: `127.0.0.1:${PORT}`,
          origin: `http://127.0.0.1:${PORT}`,
          'content-type': 'application/json; charset=utf-8',
        }),
        TOKEN,
        PORT
      )
    ).toBe('ok')
  })

  it('accepts a request without Sec-Fetch-Site', () => {
    expect(checkReplyRequest(request({ 'sec-fetch-site': undefined }), TOKEN, PORT)).toBe('ok')
  })

  it('refuses a missing or wrong token without throwing', () => {
    for (const token of [undefined, '', 'short', `${TOKEN}x`, 'A'.repeat(43)]) {
      expect(checkReplyRequest(request({ 'x-meerkat-token': token }), TOKEN, PORT)).toBe(
        'forbidden'
      )
    }
  })

  it('refuses a missing, foreign or mismatched Origin', () => {
    const origins = [
      undefined,
      'http://evil.test',
      `http://localhost:${PORT + 1}`,
      `https://localhost:${PORT}`,
      'null',
      `http://127.0.0.1:${PORT}`,
    ]
    for (const origin of origins) {
      expect(checkReplyRequest(request({ origin }), TOKEN, PORT)).toBe('forbidden')
    }
  })

  it('refuses a Sec-Fetch-Site other than same-origin', () => {
    for (const site of ['cross-site', 'same-site', 'none']) {
      expect(checkReplyRequest(request({ 'sec-fetch-site': site }), TOKEN, PORT)).toBe('forbidden')
    }
  })

  it('refuses a non-JSON content type with unsupported_media', () => {
    for (const type of [
      'text/plain',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      undefined,
    ]) {
      expect(checkReplyRequest(request({ 'content-type': type }), TOKEN, PORT)).toBe(
        'unsupported_media'
      )
    }
  })

  it('checks origin and token before content type', () => {
    expect(
      checkReplyRequest(request({ origin: undefined, 'content-type': 'text/plain' }), TOKEN, PORT)
    ).toBe('forbidden')
    expect(
      checkReplyRequest(
        request({ 'x-meerkat-token': 'bad', 'content-type': 'text/plain' }),
        TOKEN,
        PORT
      )
    ).toBe('forbidden')
  })
})
