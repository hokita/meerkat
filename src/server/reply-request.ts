import { REPLY_KEYS, type ReplyKey } from './herdr/reply-sender.js'

export type ReplyAction =
  | { type: 'option'; n: number }
  | { type: 'freeText'; text: string }
  | { type: 'prompt'; text: string }
  | { type: 'keys'; keys: ReplyKey[] }
  | { type: 'text'; text: string }

export interface ReplyRequest {
  replyId: string
  fingerprint: string
  action: ReplyAction
}

const REPLY_ID = /^[A-Za-z0-9-]{8,64}$/
const FINGERPRINT = /^[0-9a-f]{64}$/
const CONTROL = /\p{Cc}/u
const CONTROL_EXCEPT_NEWLINE = /(?!\n)\p{Cc}/u
const MAX_TEXT_CHARS = 4000
const MAX_KEYS = 9
const MAX_OPTION = 9

type Fields = Record<string, unknown>

function asRecord(value: unknown): Fields | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Fields
}

function hasExactly(fields: Fields, names: readonly string[]): boolean {
  const keys = Object.keys(fields)
  return keys.length === names.length && names.every((name) => keys.includes(name))
}

function validText(value: unknown, newlines: boolean): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  const length = [...text].length
  if (length < 1 || length > MAX_TEXT_CHARS) return null
  return (newlines ? CONTROL_EXCEPT_NEWLINE : CONTROL).test(text) ? null : text
}

function isReplyKey(value: unknown): value is ReplyKey {
  return REPLY_KEYS.some((key) => key === value)
}

function validKeys(value: unknown): ReplyKey[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_KEYS) return null
  const keys: ReplyKey[] = []
  for (const key of value) {
    if (!isReplyKey(key)) return null
    keys.push(key)
  }
  return keys
}

function validOption(value: unknown): number | null {
  const valid =
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_OPTION
  return valid ? value : null
}

function parseAction(value: unknown): ReplyAction | null {
  const fields = asRecord(value)
  if (fields === null) return null
  const type = fields['type']
  switch (type) {
    case 'option': {
      const n = hasExactly(fields, ['type', 'n']) ? validOption(fields['n']) : null
      return n === null ? null : { type, n }
    }
    case 'keys': {
      const keys = hasExactly(fields, ['type', 'keys']) ? validKeys(fields['keys']) : null
      return keys === null ? null : { type, keys }
    }
    case 'freeText':
    case 'prompt':
    case 'text': {
      const valid = hasExactly(fields, ['type', 'text'])
      const text = valid ? validText(fields['text'], type === 'prompt') : null
      return text === null ? null : { type, text }
    }
    default:
      return null
  }
}

export function parseReplyRequest(body: unknown): ReplyRequest | null {
  const fields = asRecord(body)
  if (fields === null || !hasExactly(fields, ['replyId', 'fingerprint', 'action'])) return null
  const { replyId, fingerprint } = fields
  if (typeof replyId !== 'string' || !REPLY_ID.test(replyId)) return null
  if (typeof fingerprint !== 'string' || !FINGERPRINT.test(fingerprint)) return null
  const action = parseAction(fields['action'])
  return action === null ? null : { replyId, fingerprint, action }
}
