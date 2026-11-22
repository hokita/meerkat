import type { AgentStatus, PromptOption, RecognizedPrompt } from '../shared/types.js'
import {
  MARKER,
  ansiBoxIsFaint,
  collapse,
  isBlank,
  parseOptionGroup,
  parseOptionLine,
  ruleIndices,
  screenLines,
  trimBlankEdges,
} from './prompt-blocks.js'

const PERMISSION_FOOTER = 'esc to cancel · tab to amend'
const CHOICE_FOOTER = 'enter to select · ↑/↓ to navigate · esc to cancel'
const CHAT_LABEL = 'Chat about this'
const FREE_TEXT_LABEL = 'Type something.'
const PERMISSION_QUESTION = 'Do you want to'
const DECLINING_LABEL = /^No(?:$|[\s,.])/
const CHOICE_HEADER = /^☐ (.+)$/
const TAB_STRIP = /[←→✔☐]/
const CHECKBOX_LABEL = /^\[.?\]/
const ACTIVE_SPINNER = /^[·✢✳✶✻✽⠀-⣿] .*…/
const INTERRUPT_HINT = 'esc to interrupt'

const NONE: RecognizedPrompt = { kind: 'none' }
const IDLE: RecognizedPrompt = { kind: 'idle' }
const UNRECOGNIZED: RecognizedPrompt = { kind: 'unrecognized' }

interface Dialog {
  body: string[]
  footer: string
}

function isChatOption(line: string): boolean {
  return parseOptionLine(line)?.label === CHAT_LABEL
}

function readDialog(lines: string[]): Dialog | null {
  const rules = ruleIndices(lines)
  const last = rules.at(-1)
  if (last === undefined) return null
  const below = trimBlankEdges(lines.slice(last + 1))
  const footer = below.pop()
  if (footer === undefined) return null
  const lower = trimBlankEdges(below)
  const lowerIsChatOnly = lower.length === 1 && isChatOption(lower[0] ?? '')
  if (!lowerIsChatOnly) return { body: lower, footer: collapse(footer).toLowerCase() }
  const outer = rules.at(-2)
  if (outer === undefined) return null
  const body = trimBlankEdges([...lines.slice(outer + 1, last), ...lower])
  return { body, footer: collapse(footer).toLowerCase() }
}

function permission(body: string[]): RecognizedPrompt | null {
  const group = parseOptionGroup(body)
  if (!group) return null
  const question = (body[group.start - 1] ?? '').trim()
  if (!question.startsWith(PERMISSION_QUESTION) || !question.endsWith('?')) return null
  const [title, ...rest] = trimBlankEdges(body.slice(0, group.start - 1))
  const request = trimBlankEdges(rest)
  if (title === undefined || request.length === 0) return null
  const options: PromptOption[] = group.options.map((option) => ({
    ...option,
    approving: !DECLINING_LABEL.test(option.label),
  }))
  return { kind: 'permission', tool: title.trim(), request: request.join('\n'), question, options }
}

function readHeader(lines: string[]): { header: string | null } | null {
  if (lines.length === 0) return { header: null }
  if (lines.length > 1) return null
  const line = (lines[0] ?? '').trim()
  const match = CHOICE_HEADER.exec(line)
  const header = match?.[1]?.trim() ?? ''
  if (header === '' || TAB_STRIP.test(header)) return null
  return { header }
}

function freeTextOption(options: PromptOption[]): number | null | undefined {
  const labels = options.map((option) => option.label)
  const chat = labels.indexOf(CHAT_LABEL)
  if (chat !== -1 && (chat !== labels.length - 1 || labels.lastIndexOf(CHAT_LABEL) !== chat)) {
    return undefined
  }
  const typed = labels.indexOf(FREE_TEXT_LABEL)
  if (typed === -1) return null
  const expected = chat === -1 ? labels.length - 1 : chat - 1
  if (typed !== expected || labels.lastIndexOf(FREE_TEXT_LABEL) !== typed) return undefined
  return options[typed]?.n ?? undefined
}

function choice(body: string[]): RecognizedPrompt | null {
  if (body.some((line) => line.trim() === 'Submit')) return null
  const group = parseOptionGroup(body)
  if (!group) return null
  if (group.options.some((option) => CHECKBOX_LABEL.test(option.label))) return null
  const above = body.slice(0, group.start).filter((line) => !isBlank(line))
  const question = (above.pop() ?? '').trim()
  if (!question.endsWith('?')) return null
  const header = readHeader(above)
  if (header === null) return null
  const options = group.options.map((option) => ({ ...option, approving: false }))
  const freeText = freeTextOption(options)
  if (freeText === undefined) return null
  return { kind: 'choice', header: header.header, question, options, freeTextOption: freeText }
}

function recognizeDialog(lines: string[]): RecognizedPrompt | null {
  const dialog = readDialog(lines)
  if (!dialog) return null
  if (dialog.footer === PERMISSION_FOOTER) return permission(dialog.body)
  if (dialog.footer === CHOICE_FOOTER) return choice(dialog.body)
  return null
}

function idleBoxText(lines: string[]): string | null {
  const rules = ruleIndices(lines)
  const last = rules.at(-1)
  const previous = rules.at(-2)
  if (last === undefined || previous === undefined || previous + 2 !== last) return null
  const box = lines[previous + 1] ?? ''
  if (!box.startsWith(MARKER)) return null
  const statusBar = lines.slice(last + 1)
  if (statusBar.some((line) => line.toLowerCase().includes(INTERRUPT_HINT))) return null
  if (statusBar.some((line) => line.trimStart().startsWith(MARKER))) return null
  const above = lines.slice(0, previous).findLast((line) => !isBlank(line)) ?? ''
  if (ACTIVE_SPINNER.test(above)) return null
  return collapse(box.slice(MARKER.length))
}

function isIdleStatus(status: AgentStatus): boolean {
  return status === 'idle' || status === 'done'
}

export function recognize(
  text: string,
  status: AgentStatus,
  agent: string | null,
  ansi: string | null = null
): RecognizedPrompt {
  if (status === 'working') return NONE
  if (agent !== 'claude') return UNRECOGNIZED
  const lines = screenLines(text)
  if (status === 'blocked') return recognizeDialog(lines) ?? UNRECOGNIZED
  if (!isIdleStatus(status)) return UNRECOGNIZED
  const boxText = idleBoxText(lines)
  if (boxText === null) return UNRECOGNIZED
  if (boxText === '') return IDLE
  if (ansi === null) return UNRECOGNIZED
  return ansiBoxIsFaint(ansi, boxText) ? IDLE : UNRECOGNIZED
}

export function hasIdleBoxText(text: string, status: AgentStatus, agent: string | null): boolean {
  if (!isIdleStatus(status) || agent !== 'claude') return false
  const boxText = idleBoxText(screenLines(text))
  return boxText !== null && boxText !== ''
}
