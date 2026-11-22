import { describe, expect, it } from 'vitest'
import { ALLOWED_METHODS, MethodNotAllowedError, assertAllowed } from './allowlist.js'

describe('assertAllowed', () => {
  it.each([
    'session.snapshot',
    'events.subscribe',
    'events.wait',
    'agent.list',
    'agent.get',
    'agent.read',
  ])('allows %s', (m) => expect(() => assertAllowed(m)).not.toThrow())

  it.each([
    'agent.prompt',
    'agent.start',
    'agent.send_keys',
    'agent.focus',
    'agent.rename',
    'pane.close',
    'pane.split',
    'pane.focus',
    'pane.send_text',
    'pane.send_keys',
    'pane.send_input',
    'pane.read',
    'workspace.close',
    'tab.close',
    'server.stop',
    'notification.show',
    'ping',
    '',
    'AGENT.READ',
  ])('refuses %s', (m) => expect(() => assertAllowed(m)).toThrow(MethodNotAllowedError))

  it('has exactly six methods', () => expect(ALLOWED_METHODS.size).toBe(6))
})
