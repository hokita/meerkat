import { sanitizeOutput } from './output.js'

export const MARKER = '❯'

const RULE = /^─{3,}$/
const OPTION_LINE = /^(\s*)(❯\s+)?([1-9]\d*)\.\s+(.+)$/
const MAX_OPTIONS = 9
const MIN_OPTIONS = 2

export interface ParsedOption {
  n: number
  label: string
  description: string | null
}

export interface OptionGroup {
  start: number
  options: ParsedOption[]
}

interface OptionLine {
  n: number
  label: string
  marked: boolean
  digitColumn: number
}

export function screenLines(text: string): string[] {
  return text.split('\n').map((line) => line.replaceAll(' ', ' ').trimEnd())
}

export function isRule(line: string): boolean {
  return RULE.test(line)
}

export function ruleIndices(lines: string[]): number[] {
  return lines.flatMap((line, index) => (isRule(line) ? [index] : []))
}

export function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function isBlank(line: string): boolean {
  return line.trim() === ''
}

export function trimBlankEdges(lines: string[]): string[] {
  const first = lines.findIndex((line) => !isBlank(line))
  if (first === -1) return []
  const last = lines.findLastIndex((line) => !isBlank(line))
  return lines.slice(first, last + 1)
}

export function parseOptionLine(line: string): OptionLine | null {
  const match = OPTION_LINE.exec(line)
  if (!match) return null
  const indent = match[1] ?? ''
  const marker = match[2] ?? ''
  return {
    n: Number(match[3]),
    label: (match[4] ?? '').trim(),
    marked: marker !== '',
    digitColumn: indent.length + marker.length,
  }
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

export function parseOptionGroup(body: string[]): OptionGroup | null {
  const start = body.findLastIndex((line) => parseOptionLine(line)?.n === 1)
  if (start === -1) return null
  const options: ParsedOption[] = []
  const descriptions: string[][] = []
  let marked = 0
  let column = 0
  for (const line of body.slice(start)) {
    const option = parseOptionLine(line)
    if (option) {
      if (option.n !== options.length + 1) return null
      if (option.marked) marked += 1
      column = option.digitColumn
      options.push({ n: option.n, label: option.label, description: null })
      descriptions.push([])
      continue
    }
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith(MARKER) || indentOf(line) <= column) return null
    descriptions.at(-1)?.push(trimmed)
  }
  if (marked !== 1 || options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) return null
  return {
    start,
    options: options.map((option, index) => {
      const lines = descriptions[index] ?? []
      return { ...option, description: lines.length > 0 ? lines.join(' ') : null }
    }),
  }
}

interface Cell {
  char: string
  faint: boolean
}

const ESC = '\u001b'
const SGR_PARAMS = /^[0-9;]*$/
const SGR_NEUTRAL = new Set([1, 3, 4, 5, 7, 8, 9, 21, 23, 24, 25, 27, 28, 29, 39, 49, 53, 55, 59])

function isColourCode(code: number): boolean {
  return (
    (code >= 30 && code <= 37) ||
    (code >= 40 && code <= 47) ||
    (code >= 90 && code <= 97) ||
    (code >= 100 && code <= 107)
  )
}

function applySgr(params: string, faint: boolean): boolean | null {
  const codes = params === '' ? ['0'] : params.split(';')
  if (codes.some((code) => code === '')) return null
  let next = faint
  for (let k = 0; k < codes.length; k += 1) {
    const code = Number(codes[k])
    if (code === 0 || code === 22) next = false
    else if (code === 2) next = true
    else if (code === 38 || code === 48 || code === 58) {
      const mode = codes[k + 1]
      const width = mode === '5' ? 1 : mode === '2' ? 3 : -1
      if (width === -1 || k + 1 + width >= codes.length) return null
      k += 1 + width
    } else if (!SGR_NEUTRAL.has(code) && !isColourCode(code)) return null
  }
  return next
}

function isForbiddenControl(code: number): boolean {
  return (code < 0x20 && code !== 0x09) || (code >= 0x7f && code <= 0x9f)
}

function parseAnsi(ansi: string): Cell[][] | null {
  const lines: Cell[][] = [[]]
  let faint = false
  let i = 0
  while (i < ansi.length) {
    const char = ansi[i] ?? ''
    if (char === ESC) {
      if (ansi[i + 1] !== '[') return null
      const end = ansi.indexOf('m', i + 2)
      const params = end === -1 ? '' : ansi.slice(i + 2, end)
      if (end === -1 || !SGR_PARAMS.test(params)) return null
      const next = applySgr(params, faint)
      if (next === null) return null
      faint = next
      i = end + 1
    } else if (char === '\r') {
      if (ansi[i + 1] !== '\n') return null
      i += 1
    } else if (char === '\n') {
      lines.push([])
      i += 1
    } else {
      const point = ansi.codePointAt(i) ?? 0
      if (isForbiddenControl(point)) return null
      const glyph = String.fromCodePoint(point)
      lines.at(-1)?.push({ char: glyph === ' ' ? ' ' : glyph, faint })
      i += glyph.length
    }
  }
  return lines
}

function boxRegion(ansi: string): string | null {
  const raw = ansi.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
  const rules = ruleIndices(screenLines(raw.map((line) => sanitizeOutput(line).text).join('\n')))
  const last = rules.at(-1)
  const previous = rules.at(-2)
  if (last === undefined || previous === undefined || previous + 2 !== last) return null
  return raw.slice(previous, last + 1).join('\n')
}

export function ansiBoxIsFaint(ansi: string, boxText: string): boolean {
  const region = boxRegion(ansi)
  const cells = region === null ? null : parseAnsi(region)
  if (cells === null || cells.length !== 3) return false
  const lines = cells.map((line) =>
    line
      .map((cell) => cell.char)
      .join('')
      .trimEnd()
  )
  if (!isRule(lines[0] ?? '') || !isRule(lines[2] ?? '')) return false
  const box = cells[1] ?? []
  if (box[0]?.char !== MARKER) return false
  const after = box.slice(1)
  if (collapse(after.map((cell) => cell.char).join('')) !== boxText) return false
  return after.every((cell) => /\s/.test(cell.char) || cell.faint)
}
