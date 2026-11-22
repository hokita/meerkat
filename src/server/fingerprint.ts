import { createHash } from 'node:crypto'
import type { Prompt, RecognizedPrompt } from '../shared/types.js'
import { MARKER, collapse, ruleIndices, screenLines } from './prompt-blocks.js'
import { isVolatileLine } from './progress.js'

const UNRECOGNIZED_LINES = 40

export interface FingerprintContext {
  paneId: string
  terminalId: string | null
  statusEpoch: number
  text: string
}

export interface FingerprintInput extends FingerprintContext {
  prompt: RecognizedPrompt
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function unrecognizedBlock(text: string): string[] {
  return screenLines(text)
    .filter((line) => !isVolatileLine(line))
    .slice(-UNRECOGNIZED_LINES)
}

function idleBoxLine(text: string): string {
  const lines = screenLines(text)
  const rules = ruleIndices(lines)
  const last = rules.at(-1)
  const previous = rules.at(-2)
  if (last === undefined || previous === undefined || previous + 2 !== last) return ''
  const box = lines[previous + 1] ?? ''
  return box.startsWith(MARKER) ? collapse(box.slice(MARKER.length)) : ''
}

function blockOf(input: FingerprintInput): unknown {
  if (input.prompt.kind === 'unrecognized') return unrecognizedBlock(input.text)
  if (input.prompt.kind === 'idle') return { kind: 'idle', box: idleBoxLine(input.text) }
  return input.prompt
}

export function fingerprint(input: FingerprintInput): string {
  const block = blockOf(input)
  const payload = canonical({
    paneId: input.paneId,
    terminalId: input.terminalId,
    statusEpoch: input.statusEpoch,
    kind: input.prompt.kind,
    block,
  })
  return createHash('sha256').update(payload).digest('hex')
}

export function withFingerprint(context: FingerprintContext, prompt: RecognizedPrompt): Prompt {
  if (prompt.kind === 'none') return { kind: 'none' }
  return { ...prompt, fingerprint: fingerprint({ ...context, prompt }) }
}
