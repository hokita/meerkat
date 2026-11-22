import type { Prompt, ReplyRequest } from '../shared/types'

export type ReplyResult =
  | { kind: 'sent' }
  | { kind: 'prompt_changed'; prompt: Prompt }
  | { kind: 'reloading' }
  | { kind: 'error'; message: string }

export interface ReplyEnv {
  fetch: (url: string, init: RequestInit) => Promise<Response>
  token: () => string
  reload: () => void
  storage: () => Storage
}

export const RELOAD_FLAG = 'meerkat-reloaded-for-token'

const MAX_TEXT_CHARS = 4000
const CONTROL = /\p{Cc}/u
const CONTROL_EXCEPT_NEWLINE = /(?!\n)\p{Cc}/u
const REFUSED = 'Meerkat refused the request; reload the page and try again'

function browserEnv(): ReplyEnv {
  return {
    fetch: (url, init) => globalThis.fetch(url, init),
    token: () =>
      document.querySelector('meta[name="meerkat-token"]')?.getAttribute('content') ?? '',
    reload: () => window.location.reload(),
    storage: () => window.sessionStorage,
  }
}

export function checkReplyText(text: string, newlines: boolean): string | null {
  const trimmed = text.trim()
  const length = [...trimmed].length
  if (length === 0) return 'Type something first'
  if (length > MAX_TEXT_CHARS) return 'Keep it to 4000 characters or fewer'
  if (!newlines && trimmed.includes('\n')) return "Line breaks can't be sent here"
  if ((newlines ? CONTROL_EXCEPT_NEWLINE : CONTROL).test(trimmed)) {
    return 'Remove control characters'
  }
  return null
}

function field(body: unknown, name: string): unknown {
  if (typeof body !== 'object' || body === null) return undefined
  return (body as Record<string, unknown>)[name]
}

function isPrompt(value: unknown): value is Prompt {
  return typeof field(value, 'kind') === 'string'
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

function herdrMessage(body: unknown): string {
  const code = String(field(body, 'code') ?? 'unknown')
  const sent = field(body, 'sent')
  if (typeof sent === 'number' && sent > 0) {
    return `Herdr stopped after ${sent} of the steps (${code}); check the output`
  }
  return `Herdr refused the input (${code}); nothing was sent`
}

function resultFor(status: number, body: unknown): ReplyResult {
  const error = field(body, 'error')
  const failed = (message: string): ReplyResult => ({ kind: 'error', message })
  if (status === 200) return { kind: 'sent' }
  if (status === 409 && error === 'prompt_changed') {
    const prompt = field(body, 'prompt')
    if (isPrompt(prompt)) return { kind: 'prompt_changed', prompt }
  }
  if (status === 409 && error === 'not_waiting') {
    return failed('The session is working again; nothing was sent')
  }
  if (status === 400) return failed(`Meerkat refused this reply (${String(error)})`)
  if (status === 404) return failed('Session closed')
  if (status === 503) return failed('Herdr is not reachable; nothing was sent')
  if (status === 502) return failed(herdrMessage(body))
  if (status === 413) return failed('The reply is too long')
  if (status === 415) return failed('Meerkat refused the request format')
  return failed(`Reply failed (${status})`)
}

function markReload(env: ReplyEnv): boolean {
  try {
    const storage = env.storage()
    if (storage.getItem(RELOAD_FLAG) !== null) return false
    storage.setItem(RELOAD_FLAG, '1')
    return true
  } catch {
    return false
  }
}

function reloadOnce(env: ReplyEnv): ReplyResult {
  if (!markReload(env)) return { kind: 'error', message: REFUSED }
  env.reload()
  return { kind: 'reloading' }
}

function forgetReload(env: ReplyEnv): void {
  try {
    env.storage().removeItem(RELOAD_FLAG)
  } catch {
    return
  }
}

export async function sendReply(
  paneId: string,
  request: ReplyRequest,
  env: ReplyEnv = browserEnv()
): Promise<ReplyResult> {
  let response: Response
  try {
    response = await env.fetch('/api/sessions/' + encodeURIComponent(paneId) + '/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Meerkat-Token': env.token() },
      body: JSON.stringify(request),
    })
  } catch {
    return {
      kind: 'error',
      message: 'Could not reach Meerkat; check the output before trying again',
    }
  }
  if (response.status === 403) return reloadOnce(env)
  forgetReload(env)
  return resultFor(response.status, await readBody(response))
}
