import { describe, expect, it } from 'vitest'
import { HERDR_METHODS } from '../../../test-support/herdr-methods.js'
import {
  MethodNotAllowedError,
  READ_METHODS,
  REPLY_METHODS,
  assertReadAllowed,
  assertReplyAllowed,
} from './allowlist.js'

const READ = [
  'session.snapshot',
  'events.subscribe',
  'events.wait',
  'agent.list',
  'agent.get',
  'agent.read',
]
const REPLY = ['agent.prompt', 'agent.send_keys', 'pane.send_text']

function passes(assert: (method: string) => void, method: string): boolean {
  try {
    assert(method)
    return true
  } catch (error) {
    if (error instanceof MethodNotAllowedError) return false
    throw error
  }
}

describe('allow-lists', () => {
  it('knows the schema methods', () => expect(HERDR_METHODS.length).toBe(102))

  it('has six read and three reply methods', () => {
    expect(READ_METHODS.size).toBe(6)
    expect(REPLY_METHODS.size).toBe(3)
  })

  it.each([...HERDR_METHODS])('routes %s to at most one path', (method) => {
    const read = passes(assertReadAllowed, method)
    const reply = passes(assertReplyAllowed, method)
    expect(read).toBe(READ.includes(method))
    expect(reply).toBe(REPLY.includes(method))
    expect(read && reply).toBe(false)
  })

  it.each([
    'server.stop',
    'pane.close',
    'agent.start',
    'pane.run',
    'pane.send_keys',
    'pane.send_input',
    'agent.focus',
    '',
    'AGENT.PROMPT',
  ])('refuses %s on both paths', (method) => {
    expect(() => assertReadAllowed(method)).toThrow(MethodNotAllowedError)
    expect(() => assertReplyAllowed(method)).toThrow(MethodNotAllowedError)
  })
})
