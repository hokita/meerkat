import type { Card, Prompt, RecognizedPrompt } from '../shared/types.js'
import { withFingerprint } from './fingerprint.js'
import type { HerdrClient } from './herdr/client.js'
import { parseReadResponse } from './herdr/protocol.js'
import { sanitizeOutput } from './output.js'
import { hasIdleBoxText, recognize } from './prompt.js'
import { readScreen } from './read-screen.js'
import type { Supervisor } from './supervisor.js'

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

async function readAnsi(client: HerdrClient, target: string): Promise<string | null> {
  try {
    const read = parseReadResponse(
      await client.request('agent.read', {
        target,
        source: 'visible',
        format: 'ansi',
        strip_ansi: false,
      })
    )
    return read.kind === 'ok' ? read.text : null
  } catch {
    return null
  }
}

function sameSession(before: Card, after: Card): boolean {
  return before.statusEpoch === after.statusEpoch && before.terminalId === after.terminalId
}

export async function readPrompt(
  opts: ReadPromptOptions,
  paneId: string
): Promise<PromptRead | 'gone' | 'changed'> {
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
  const after = opts.supervisor.card(paneId)
  if (after === undefined) return 'gone'
  if (!sameSession(card, after)) return 'changed'
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
