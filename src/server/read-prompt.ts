import type { Prompt, RecognizedPrompt } from '../shared/types.js'
import { withFingerprint } from './fingerprint.js'
import type { HerdrClient } from './herdr/client.js'
import { HerdrProtocolError, parseReadResponse } from './herdr/protocol.js'
import { sanitizeOutput } from './output.js'
import { hasIdleBoxText, recognize } from './prompt.js'
import type { Supervisor } from './supervisor.js'

const RECOGNITION_LINES = 120
const SHOWN_LINES = 40

export interface ReadPromptOptions {
  client: HerdrClient
  supervisor: Pick<Supervisor, 'card'>
}

export interface PromptRead {
  text: string
  truncated: boolean
  prompt: Prompt
}

type Read = { kind: 'gone' } | { kind: 'ok'; text: string; truncated: boolean }

async function readOnce(client: HerdrClient, params: object): Promise<Read> {
  return parseReadResponse(await client.request('agent.read', params))
}

async function readScreen(client: HerdrClient, target: string): Promise<Read> {
  const base = { target, format: 'text', strip_ansi: true }
  try {
    return await readOnce(client, { ...base, source: 'recent_unwrapped', lines: RECOGNITION_LINES })
  } catch (error) {
    if (error instanceof HerdrProtocolError && error.code === 'agent_not_idle') {
      return readOnce(client, { ...base, source: 'visible' })
    }
    throw error
  }
}

async function readAnsi(client: HerdrClient, target: string): Promise<string | null> {
  try {
    const read = await readOnce(client, {
      target,
      source: 'visible',
      format: 'ansi',
      strip_ansi: false,
    })
    return read.kind === 'ok' ? read.text : null
  } catch {
    return null
  }
}

export async function readPrompt(
  opts: ReadPromptOptions,
  paneId: string
): Promise<PromptRead | 'gone'> {
  const card = opts.supervisor.card(paneId)
  if (card === undefined) return 'gone'
  const read = await readScreen(opts.client, paneId)
  if (read.kind === 'gone') return 'gone'
  const sanitized = sanitizeOutput(read.text)
  const text = sanitized.text
  let recognized: RecognizedPrompt =
    card.status === 'working' ? { kind: 'none' } : recognize(text, card.status, card.agent)
  if (hasIdleBoxText(text, card.status, card.agent)) {
    const ansi = await readAnsi(opts.client, paneId)
    if (ansi !== null) recognized = recognize(text, card.status, card.agent, ansi)
  }
  const prompt = withFingerprint(
    { paneId: card.paneId, terminalId: card.terminalId, statusEpoch: card.statusEpoch, text },
    recognized
  )
  const lines = text.split('\n')
  return {
    text: lines.slice(-SHOWN_LINES).join('\n'),
    truncated: read.truncated || sanitized.clipped || lines.length > SHOWN_LINES,
    prompt,
  }
}
