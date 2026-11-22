import { describe, expect, it, vi } from 'vitest'
import type { Prompt, ReplyRequest } from '../shared/types'
import { checkReplyText, RELOAD_FLAG, sendReply, type ReplyEnv } from './replyApi'

const request: ReplyRequest = {
  replyId: 'abcdef12-3456',
  fingerprint: 'f'.repeat(64),
  action: { type: 'option', n: 1 },
}

const changed: Prompt = { kind: 'idle', fingerprint: 'e'.repeat(64) }

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status })
}

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  }
}

function env(response: Response | Error) {
  const fetch = vi.fn<ReplyEnv['fetch']>(() =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response.clone())
  )
  const reload = vi.fn()
  const store = memoryStorage()
  const value: ReplyEnv = { fetch, reload, token: () => 'tok-123', storage: () => store }
  return { value, fetch, reload, store }
}

describe('sendReply', () => {
  it('posts exactly the request with the token and JSON content type', async () => {
    const e = env(json({ sent: 1 }, 200))
    await expect(sendReply('w1:p1', request, e.value)).resolves.toEqual({ kind: 'sent' })
    const [url, init] = e.fetch.mock.calls[0] ?? []
    expect(url).toBe('/api/sessions/w1%3Ap1/reply')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Meerkat-Token': 'tok-123',
    })
    expect(JSON.parse(String(init?.body))).toEqual(request)
  })

  it('reads the token from the meerkat-token meta tag by default', async () => {
    document.head.innerHTML = '<meta name="meerkat-token" content="from-meta">'
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ sent: 1 }, 200))
    vi.stubGlobal('fetch', fetch)
    await sendReply('p1', request)
    const headers = fetch.mock.calls[0]?.[1]?.headers as Record<string, string>
    expect(headers['X-Meerkat-Token']).toBe('from-meta')
    vi.unstubAllGlobals()
    document.head.innerHTML = ''
  })

  it('returns the new prompt for prompt_changed', async () => {
    const e = env(json({ error: 'prompt_changed', prompt: changed }, 409))
    await expect(sendReply('p1', request, e.value)).resolves.toEqual({
      kind: 'prompt_changed',
      prompt: changed,
    })
  })

  it.each([
    [409, { error: 'not_waiting' }, 'The session is working again; nothing was sent'],
    [400, { error: 'invalid_action' }, 'Meerkat refused this reply (invalid_action)'],
    [400, { error: 'invalid_body' }, 'Meerkat refused this reply (invalid_body)'],
    [404, { error: 'session_closed' }, 'Session closed'],
    [503, { error: 'herdr_unreachable' }, 'Herdr is not reachable; nothing was sent'],
    [
      502,
      { error: 'herdr_error', code: 'agent_blocked', sent: 0 },
      'Herdr refused the input (agent_blocked); nothing was sent',
    ],
    [
      502,
      { error: 'herdr_error', code: 'timeout', sent: 1 },
      'Herdr stopped after 1 of the steps (timeout); check the output',
    ],
    [413, { error: 'body_too_large' }, 'The reply is too long'],
    [415, { error: 'unsupported_media' }, 'Meerkat refused the request format'],
    [500, { error: 'boom' }, 'Reply failed (500)'],
    [409, { error: 'prompt_changed' }, 'Reply failed (409)'],
  ])('maps %i %o to an error message', async (status, body, message) => {
    const e = env(json(body, status))
    await expect(sendReply('p1', request, e.value)).resolves.toEqual({ kind: 'error', message })
  })

  it('reports a network failure without claiming nothing was sent', async () => {
    const e = env(new TypeError('network'))
    await expect(sendReply('p1', request, e.value)).resolves.toEqual({
      kind: 'error',
      message: 'Could not reach Meerkat; check the output before trying again',
    })
  })

  it('reloads once on 403', async () => {
    const e = env(json({ error: 'forbidden' }, 403))
    await expect(sendReply('p1', request, e.value)).resolves.toEqual({ kind: 'reloading' })
    expect(e.reload).toHaveBeenCalledTimes(1)
    expect(e.store.getItem(RELOAD_FLAG)).not.toBeNull()
    await expect(sendReply('p1', request, e.value)).resolves.toEqual({
      kind: 'error',
      message: 'Meerkat refused the request; reload the page and try again',
    })
    expect(e.reload).toHaveBeenCalledTimes(1)
  })

  it('clears the reload flag after a request that is not refused', async () => {
    const e = env(json({ sent: 1 }, 200))
    e.store.setItem(RELOAD_FLAG, '1')
    await sendReply('p1', request, e.value)
    expect(e.store.getItem(RELOAD_FLAG)).toBeNull()
  })

  it('shows an error instead of reloading when session storage throws', async () => {
    const e = env(json({ error: 'forbidden' }, 403))
    const broken: ReplyEnv = {
      ...e.value,
      storage: () => {
        throw new Error('blocked')
      },
    }
    await expect(sendReply('p1', request, broken)).resolves.toEqual({
      kind: 'error',
      message: 'Meerkat refused the request; reload the page and try again',
    })
    expect(e.reload).not.toHaveBeenCalled()
  })
})

describe('checkReplyText', () => {
  it('accepts 1 to 4000 characters after trimming', () => {
    expect(checkReplyText('  hi  ', false)).toBeNull()
    expect(checkReplyText('x'.repeat(4000), false)).toBeNull()
    expect(checkReplyText('😀'.repeat(4000), false)).toBeNull()
  })

  it('rejects empty, too long and control characters', () => {
    expect(checkReplyText('   ', false)).toBe('Type something first')
    expect(checkReplyText('x'.repeat(4001), false)).toBe('Keep it to 4000 characters or fewer')
    expect(checkReplyText('a\u0007b', true)).toBe('Remove control characters')
  })

  it('allows a newline only where newlines are allowed', () => {
    expect(checkReplyText('one\ntwo', true)).toBeNull()
    expect(checkReplyText('one\ntwo', false)).toBe("Line breaks can't be sent here")
  })
})
