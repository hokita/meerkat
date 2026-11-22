import type { Prompt, PromptOption, ReplyRequest } from '../shared/types'

export type ReplyResult =
  | { kind: 'sent' }
  | { kind: 'prompt_changed'; prompt: Prompt }
  | { kind: 'reloading' }
  | { kind: 'error'; message: string }
  | { kind: 'unsure'; message: string }

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOption(value: unknown): value is PromptOption {
  return (
    isRecord(value) &&
    Number.isInteger(value['n']) &&
    typeof value['label'] === 'string' &&
    (value['description'] === null || typeof value['description'] === 'string') &&
    typeof value['approving'] === 'boolean'
  )
}

function isOptions(value: unknown): boolean {
  return Array.isArray(value) && value.every(isOption)
}

function isWellFormed(value: Record<string, unknown>): boolean {
  const strings = (...names: string[]) => names.every((name) => typeof value[name] === 'string')
  switch (value['kind']) {
    case 'none':
      return true
    case 'idle':
    case 'unrecognized':
      return strings('fingerprint')
    case 'permission':
      return strings('fingerprint', 'tool', 'request', 'question') && isOptions(value['options'])
    case 'choice':
      return (
        strings('fingerprint', 'question') &&
        (value['header'] === null || typeof value['header'] === 'string') &&
        (value['freeTextOption'] === null || Number.isInteger(value['freeTextOption'])) &&
        isOptions(value['options'])
      )
    default:
      return false
  }
}

export function parsePrompt(value: unknown): Prompt | null {
  return isRecord(value) && isWellFormed(value) ? (value as unknown as Prompt) : null
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

function herdrResult(body: unknown): ReplyResult {
  const code = String(field(body, 'code') ?? 'unknown')
  const sent = field(body, 'sent')
  if (field(body, 'uncertain') === true) {
    return {
      kind: 'unsure',
      message: `Meerkat can't tell whether Herdr typed the input (${code}); check the output`,
    }
  }
  if (typeof sent === 'number' && sent > 0) {
    return {
      kind: 'unsure',
      message: `Herdr stopped after ${sent} of the steps (${code}); check the output`,
    }
  }
  return { kind: 'error', message: `Herdr refused the input (${code}); nothing was sent` }
}

function resultFor(status: number, body: unknown): ReplyResult {
  const error = field(body, 'error')
  const failed = (message: string): ReplyResult => ({ kind: 'error', message })
  if (status === 200) return { kind: 'sent' }
  if (status === 409 && error === 'prompt_changed') {
    const prompt = parsePrompt(field(body, 'prompt'))
    if (prompt !== null) return { kind: 'prompt_changed', prompt }
  }
  if (status === 409 && error === 'not_waiting') {
    return failed('The session is working again; nothing was sent')
  }
  if (status === 409 && error === 'session_changed') {
    return failed('The session changed while Meerkat was reading it; nothing was sent')
  }
  if (status === 400) return failed(`Meerkat refused this reply (${String(error)})`)
  if (status === 404) return failed('Session closed')
  if (status === 503) return failed('Herdr is not reachable; nothing was sent')
  if (status === 502) return herdrResult(body)
  if (status === 413) return failed('The reply is too long')
  if (status === 415) return failed('Meerkat refused the request format')
  return failed(`Reply failed (${status})`)
}

function markReload(env: ReplyEnv): boolean {
  try {
    const storage = env.storage()
    const token = env.token()
    if (storage.getItem(RELOAD_FLAG) === token) return false
    storage.setItem(RELOAD_FLAG, token)
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
      kind: 'unsure',
      message: 'Could not reach Meerkat; check the output before trying again',
    }
  }
  if (response.status === 403) return reloadOnce(env)
  return resultFor(response.status, await readBody(response))
}
