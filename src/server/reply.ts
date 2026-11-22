import type { Readable } from 'node:stream'
import type { Prompt } from '../shared/types.js'
import { HerdrProtocolError } from './herdr/protocol.js'
import { REPLY_KEYS, type ReplyKey, type ReplySender } from './herdr/reply-sender.js'
import { paneIdFromSegment } from './pane-id.js'
import type { PromptRead } from './read-prompt.js'
import { parseReplyRequest, type ReplyAction } from './reply-request.js'
import type { Supervisor } from './supervisor.js'

export type { ReplyAction, ReplyRequest } from './reply-request.js'

export interface ReplyResult {
  status: number
  body: unknown
}

export interface ReplyMemory {
  recall(paneId: string, replyId: string): ReplyResult | undefined
  remember(paneId: string, replyId: string, result: ReplyResult): void
  withLock<T>(paneId: string, task: () => Promise<T>): Promise<T>
}

export interface ReplyDeps {
  supervisor: Pick<Supervisor, 'current' | 'recordReply' | 'refreshProgress'>
  read: (paneId: string) => Promise<PromptRead | 'gone'>
  sender: ReplySender
  memory: ReplyMemory
}

export const MAX_BODY_BYTES = 8192
export const REPLY_MEMORY_MS = 300_000
const MAX_SUMMARY_CHARS = 80

type Waiting = Exclude<Prompt, { kind: 'none' }>
type Step = (sender: ReplySender, paneId: string) => Promise<void>

interface Plan {
  steps: Step[]
  summary: string
}

export function createReplyMemory(now: () => number = Date.now): ReplyMemory {
  const results = new Map<string, { at: number; result: ReplyResult }>()
  const locks = new Map<string, Promise<void>>()

  function expire(): void {
    const cutoff = now() - REPLY_MEMORY_MS
    for (const [key, entry] of results) {
      if (entry.at > cutoff) return
      results.delete(key)
    }
  }

  const keyOf = (paneId: string, replyId: string): string => `${paneId}\n${replyId}`

  return {
    recall(paneId, replyId) {
      expire()
      return results.get(keyOf(paneId, replyId))?.result
    },
    remember(paneId, replyId, result) {
      expire()
      const key = keyOf(paneId, replyId)
      results.delete(key)
      results.set(key, { at: now(), result })
    },
    withLock(paneId, task) {
      const previous = locks.get(paneId) ?? Promise.resolve()
      const run = previous.then(task)
      const settled = run.then(
        () => undefined,
        () => undefined
      )
      locks.set(paneId, settled)
      void settled.then(() => {
        if (locks.get(paneId) === settled) locks.delete(paneId)
      })
      return run
    },
  }
}

function clip(summary: string): string {
  const chars = [...summary]
  if (chars.length <= MAX_SUMMARY_CHARS) return summary
  return `${chars.slice(0, MAX_SUMMARY_CHARS - 1).join('')}…`
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ')
}

function keysStep(keys: readonly ReplyKey[]): Step {
  return (sender, paneId) => sender.sendKeys(paneId, keys)
}

function digitKey(n: number): ReplyKey | undefined {
  return REPLY_KEYS.find((key) => key === String(n))
}

function planFor(prompt: Waiting, action: ReplyAction): Plan | null {
  switch (action.type) {
    case 'option': {
      if (prompt.kind !== 'permission' && prompt.kind !== 'choice') return null
      if (prompt.kind === 'choice' && action.n === prompt.freeTextOption) return null
      const chosen = prompt.options.find((option) => option.n === action.n)
      const key = digitKey(action.n)
      if (chosen === undefined || key === undefined) return null
      return { steps: [keysStep([key])], summary: `Answered "${chosen.label}"` }
    }
    case 'freeText': {
      if (prompt.kind !== 'choice' || prompt.freeTextOption === null) return null
      const key = digitKey(prompt.freeTextOption)
      if (key === undefined) return null
      const { text } = action
      return {
        steps: [
          keysStep([key]),
          (sender, paneId) => sender.sendText(paneId, text),
          keysStep(['enter']),
        ],
        summary: `Answered "${oneLine(text)}"`,
      }
    }
    case 'prompt': {
      if (prompt.kind !== 'idle') return null
      const { text } = action
      return {
        steps: [(sender, paneId) => sender.prompt(paneId, text)],
        summary: `Sent "${oneLine(text)}"`,
      }
    }
    case 'keys':
      if (prompt.kind !== 'unrecognized') return null
      return { steps: [keysStep(action.keys)], summary: `Pressed ${action.keys.join(' ')}` }
    case 'text': {
      if (prompt.kind !== 'unrecognized') return null
      const { text } = action
      return {
        steps: [(sender, paneId) => sender.sendText(paneId, text)],
        summary: `Typed "${oneLine(text)}"`,
      }
    }
  }
}

function herdrError(error: unknown, sent: number): ReplyResult {
  const code = error instanceof HerdrProtocolError ? error.code : 'unknown'
  return { status: 502, body: { error: 'herdr_error', code, sent } }
}

async function answer(
  deps: ReplyDeps,
  paneId: string,
  fingerprint: string,
  action: ReplyAction
): Promise<ReplyResult> {
  let read: PromptRead | 'gone'
  try {
    read = await deps.read(paneId)
  } catch (error) {
    return herdrError(error, 0)
  }
  if (read === 'gone') return { status: 404, body: { error: 'session_closed' } }
  const { prompt } = read
  if (prompt.kind === 'none') return { status: 409, body: { error: 'not_waiting' } }
  if (prompt.fingerprint !== fingerprint) {
    return { status: 409, body: { error: 'prompt_changed', prompt } }
  }
  const plan = planFor(prompt, action)
  if (plan === null) return { status: 400, body: { error: 'invalid_action' } }
  let sent = 0
  for (const step of plan.steps) {
    try {
      await step(deps.sender, paneId)
    } catch (error) {
      return herdrError(error, sent)
    }
    sent += 1
  }
  deps.supervisor.recordReply(paneId, clip(plan.summary))
  deps.supervisor.refreshProgress(paneId)
  return { status: 200, body: { sent } }
}

export async function handleReply(
  deps: ReplyDeps,
  paneId: string,
  body: unknown
): Promise<ReplyResult> {
  const request = parseReplyRequest(body)
  if (request === null) return { status: 400, body: { error: 'invalid_body' } }
  const { replyId, fingerprint, action } = request
  const stored = deps.memory.recall(paneId, replyId)
  if (stored !== undefined) return stored
  return deps.memory.withLock(paneId, async () => {
    const again = deps.memory.recall(paneId, replyId)
    if (again !== undefined) return again
    const result = await answer(deps, paneId, fingerprint, action)
    deps.memory.remember(paneId, replyId, result)
    return result
  })
}

export type BodyRead = { kind: 'ok'; text: string } | { kind: 'too_large' }

export function readBody(req: Readable, limit: number): Promise<BodyRead> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (outcome: BodyRead): void => {
      done = true
      resolve(outcome)
    }
    const onData = (chunk: Buffer): void => {
      if (done) return
      size += chunk.length
      if (size > limit) {
        chunks.length = 0
        finish({ kind: 'too_large' })
        return
      }
      chunks.push(chunk)
    }
    req.on('data', onData)
    req.once('end', () => {
      if (!done) finish({ kind: 'ok', text: Buffer.concat(chunks).toString('utf8') })
    })
    req.once('error', reject)
    req.once('close', () => {
      if (!done) reject(new Error('request closed before the body ended'))
    })
  })
}

function parseJson(text: string): { value: unknown } | null {
  try {
    return { value: JSON.parse(text) as unknown }
  } catch {
    return null
  }
}

export async function serveReply(
  deps: ReplyDeps,
  req: Readable,
  segment: string
): Promise<ReplyResult> {
  const paneId = paneIdFromSegment(segment)
  if (paneId === null) return { status: 400, body: { error: 'invalid_pane_id' } }
  if (deps.supervisor.current().herdr !== 'connected') {
    return { status: 503, body: { error: 'herdr_unreachable' } }
  }
  const body = await readBody(req, MAX_BODY_BYTES)
  if (body.kind === 'too_large') return { status: 413, body: { error: 'body_too_large' } }
  const parsed = parseJson(body.text)
  if (parsed === null) return { status: 400, body: { error: 'invalid_body' } }
  return handleReply(deps, paneId, parsed.value)
}
