import type { HerdrClient } from './herdr/client.js'
import { parseReadResponse } from './herdr/protocol.js'
import { sanitizeOutput } from './output.js'

export const MAX_PROGRESS_CHARS = 280

const MARKER = '⏺'
const RESULT_MARKER = '⎿'
const TOOL_CALL_HEAD = /^[A-Za-z][\w-]*(?: [A-Za-z][\w-]*)*\(/
const MCP_TOOL_CALL = '(MCP)('
const SHORTCUTS_FOOTER = '? for shortcuts'
const BOX_DRAWING_ONLY = /^[─-╿ ]+$/
const SPINNER_LINE = /^[·✢✳✶✻✽⠀-⣿] /

function normalizeLine(line: string): string {
  return line.replaceAll('\u00a0', ' ').trimEnd()
}

function isResultLine(line: string): boolean {
  return line.trim().startsWith(RESULT_MARKER)
}

function isMarkerLine(line: string): boolean {
  return line === MARKER || line.startsWith(MARKER + ' ')
}

function isChrome(line: string): boolean {
  const trimmed = line.trim()
  return (
    BOX_DRAWING_ONLY.test(line) ||
    /^[│╭╰]/.test(line) ||
    line.startsWith('❯') ||
    trimmed.startsWith('⏵') ||
    trimmed.startsWith(RESULT_MARKER) ||
    trimmed.startsWith(SHORTCUTS_FOOTER) ||
    SPINNER_LINE.test(line)
  )
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function cap(text: string): string {
  const points = Array.from(text)
  if (points.length <= MAX_PROGRESS_CHARS) return text
  return points.slice(0, MAX_PROGRESS_CHARS - 1).join('') + '…'
}

interface Block {
  text: string
  isToolCall: boolean
}

function readBlock(lines: string[], start: number): Block {
  const head = (lines[start] ?? '').slice(MARKER.length).trim()
  const parts = [head]
  let next = start + 1
  while (next < lines.length) {
    const line = lines[next] ?? ''
    if (!line.startsWith('  ') || line.trim() === '' || isResultLine(line)) break
    parts.push(line)
    next += 1
  }
  while (next < lines.length && (lines[next] ?? '').trim() === '') next += 1
  const followedByResult = next < lines.length && isResultLine(lines[next] ?? '')
  return {
    text: collapse(parts.join(' ')),
    isToolCall: TOOL_CALL_HEAD.test(head) || head.includes(MCP_TOOL_CALL) || followedByResult,
  }
}

export function extractProgress(text: string): string | null {
  const lines = text.split('\n').map(normalizeLine)
  const blocks: Block[] = []
  lines.forEach((line, index) => {
    if (isMarkerLine(line)) blocks.push(readBlock(lines, index))
  })
  if (blocks.length > 0) {
    const last = blocks.findLast((block) => !block.isToolCall && block.text !== '')
    return last ? cap(last.text) : null
  }
  const fallback = lines.findLast((line) => line.trim() !== '' && !isChrome(line))
  return fallback === undefined ? null : cap(collapse(fallback))
}

export async function readProgress(client: HerdrClient, paneId: string): Promise<string | null> {
  const line = await client.request('agent.read', {
    target: paneId,
    source: 'recent_unwrapped',
    lines: 120,
    format: 'text',
    strip_ansi: true,
  })
  const read = parseReadResponse(line)
  if (read.kind === 'gone') return null
  return extractProgress(sanitizeOutput(read.text).text)
}
