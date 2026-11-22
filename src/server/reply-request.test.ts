import { describe, expect, it } from 'vitest'
import { parseReplyRequest } from './reply-request.js'

const FP = 'a'.repeat(64)

function body(action: unknown, extra: Record<string, unknown> = {}): unknown {
  return { replyId: 'reply-0001', fingerprint: FP, action, ...extra }
}

describe('parseReplyRequest', () => {
  it.each([
    [{ type: 'option', n: 1 }],
    [{ type: 'option', n: 9 }],
    [{ type: 'freeText', text: 'Medium please' }],
    [{ type: 'prompt', text: 'continue' }],
    [{ type: 'keys', keys: ['1'] }],
    [{ type: 'keys', keys: ['1', '2', '3', '4', '5', '6', '7', '8', 'esc'] }],
    [{ type: 'text', text: 'hello' }],
  ])('accepts %j', (action) => {
    expect(parseReplyRequest(body(action))).toEqual({
      replyId: 'reply-0001',
      fingerprint: FP,
      action,
    })
  })

  it('trims text and keeps newlines only for prompt', () => {
    expect(parseReplyRequest(body({ type: 'prompt', text: '  line one\nline two \n' }))).toEqual({
      replyId: 'reply-0001',
      fingerprint: FP,
      action: { type: 'prompt', text: 'line one\nline two' },
    })
    expect(parseReplyRequest(body({ type: 'text', text: '  hi  ' }))?.action).toEqual({
      type: 'text',
      text: 'hi',
    })
  })

  it('accepts 4000 characters and refuses 4001', () => {
    expect(parseReplyRequest(body({ type: 'text', text: 'x'.repeat(4000) }))).not.toBeNull()
    expect(parseReplyRequest(body({ type: 'text', text: 'x'.repeat(4001) }))).toBeNull()
    expect(parseReplyRequest(body({ type: 'text', text: '😀'.repeat(4000) }))).not.toBeNull()
  })

  it.each([
    ['null', null],
    ['an array', [FP]],
    ['a string', 'hello'],
    ['no replyId', { fingerprint: FP, action: { type: 'option', n: 1 } }],
    ['a short replyId', body({ type: 'option', n: 1 }, { replyId: 'abc1234' })],
    ['a long replyId', body({ type: 'option', n: 1 }, { replyId: 'a'.repeat(65) })],
    ['a replyId with bad characters', body({ type: 'option', n: 1 }, { replyId: 'reply_0001' })],
    ['a numeric replyId', body({ type: 'option', n: 1 }, { replyId: 12345678 })],
    ['an uppercase fingerprint', body({ type: 'option', n: 1 }, { fingerprint: 'A'.repeat(64) })],
    ['a short fingerprint', body({ type: 'option', n: 1 }, { fingerprint: 'a'.repeat(63) })],
    ['an extra top-level field', body({ type: 'option', n: 1 }, { force: true })],
    ['no action', { replyId: 'reply-0001', fingerprint: FP }],
    ['an unknown action type', body({ type: 'run', text: 'ls' })],
    ['an extra action field', body({ type: 'option', n: 1, text: 'x' })],
    ['option 0', body({ type: 'option', n: 0 })],
    ['option 10', body({ type: 'option', n: 10 })],
    ['option 1.5', body({ type: 'option', n: 1.5 })],
    ['option "1"', body({ type: 'option', n: '1' })],
    ['empty keys', body({ type: 'keys', keys: [] })],
    ['ten keys', body({ type: 'keys', keys: Array<string>(10).fill('1') })],
    ['an unknown key', body({ type: 'keys', keys: ['1', 'up'] })],
    ['keys that are not an array', body({ type: 'keys', keys: '1' })],
    ['empty text', body({ type: 'text', text: '' })],
    ['blank text', body({ type: 'prompt', text: ' \n ' })],
    ['non-string text', body({ type: 'prompt', text: 5 })],
    ['a newline in text', body({ type: 'text', text: 'a\nb' })],
    ['a newline in freeText', body({ type: 'freeText', text: 'a\nb' })],
    ['a tab', body({ type: 'prompt', text: 'a\tb' })],
    ['a carriage return', body({ type: 'prompt', text: 'a\rb' })],
    ['an escape', body({ type: 'prompt', text: 'a\u001b[2Jb' })],
    ['a bell', body({ type: 'text', text: 'a\u0007' })],
    ['DEL', body({ type: 'text', text: 'a\u007f' })],
    ['a C1 control', body({ type: 'text', text: 'a\u009bb' })],
  ])('refuses %s', (_name, value) => {
    expect(parseReplyRequest(value)).toBeNull()
  })
})
