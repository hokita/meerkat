import { describe, expect, it } from 'vitest'
import type { RecognizedPrompt } from '../shared/types.js'
import { fingerprint, withFingerprint } from './fingerprint.js'

const permission: RecognizedPrompt = {
  kind: 'permission',
  tool: 'Bash command',
  request: 'npm test',
  question: 'Do you want to proceed?',
  options: [
    { n: 1, label: 'Yes', description: null, approving: true },
    { n: 2, label: 'No', description: null, approving: false },
  ],
}

const base = { paneId: 'p1', terminalId: 't1', statusEpoch: 3, prompt: permission, text: '' }

describe('fingerprint', () => {
  it('is a stable sha256 hex for identical inputs', () => {
    const a = fingerprint(base)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(fingerprint({ ...base })).toBe(a)
  })

  it('ignores the screen text for recognized kinds', () => {
    expect(fingerprint({ ...base, text: 'x\n✻ Working… (3s)' })).toBe(fingerprint(base))
  })

  it('changes with option label, request, terminalId, statusEpoch, paneId and kind', () => {
    const a = fingerprint(base)
    const relabeled = {
      ...permission,
      options: [{ n: 1, label: 'Yep', description: null, approving: true }],
    } as RecognizedPrompt
    const requested = { ...permission, request: 'npm run build' } as RecognizedPrompt
    expect(fingerprint({ ...base, prompt: relabeled })).not.toBe(a)
    expect(fingerprint({ ...base, prompt: requested })).not.toBe(a)
    expect(fingerprint({ ...base, terminalId: 't2' })).not.toBe(a)
    expect(fingerprint({ ...base, terminalId: null })).not.toBe(a)
    expect(fingerprint({ ...base, statusEpoch: 4 })).not.toBe(a)
    expect(fingerprint({ ...base, paneId: 'p2' })).not.toBe(a)
    expect(fingerprint({ ...base, prompt: { kind: 'idle' } })).not.toBe(a)
  })

  describe('unrecognized', () => {
    const prompt: RecognizedPrompt = { kind: 'unrecognized' }
    const screen = ['Some question?', '  1. A', '  2. B', '❯ draft'].join('\n')
    const input = { ...base, prompt, text: screen }

    it('ignores spinner, timer and status-bar lines', () => {
      const a = fingerprint(input)
      const noisy = [
        'Some question?',
        '  1. A',
        '  2. B',
        '✻ Working… (12s · esc to interrupt)',
        '❯ draft',
        '  ⏵⏵ accept edits on (shift+tab to cycle)',
      ].join('\n')
      expect(fingerprint({ ...input, text: noisy })).toBe(a)
    })

    it('changes with the content, including the draft line', () => {
      const a = fingerprint(input)
      expect(fingerprint({ ...input, text: screen.replace('A', 'C') })).not.toBe(a)
      expect(fingerprint({ ...input, text: screen.replace('draft', 'other') })).not.toBe(a)
      expect(fingerprint({ ...input, statusEpoch: 4 })).not.toBe(a)
    })

    it('only considers the last 40 lines', () => {
      const tail = Array.from({ length: 40 }, (_, i) => `line ${i}`)
      const a = fingerprint({ ...input, text: ['old', ...tail].join('\n') })
      expect(fingerprint({ ...input, text: ['different', ...tail].join('\n') })).toBe(a)
    })
  })
})

describe('withFingerprint', () => {
  it('adds a fingerprint to every kind except none', () => {
    const got = withFingerprint(
      { paneId: 'p1', terminalId: 't1', statusEpoch: 1, text: '' },
      permission
    )
    expect(got).toMatchObject({
      kind: 'permission',
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect(
      withFingerprint(
        { paneId: 'p1', terminalId: null, statusEpoch: 1, text: '' },
        { kind: 'none' }
      )
    ).toEqual({
      kind: 'none',
    })
  })
})
