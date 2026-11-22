import { afterEach, describe, expect, it } from 'vitest'
import { fakeSnapshot, startFakeHerdr, type FakeHerdr } from '../../test-support/fake-herdr.js'
import { createHerdrClient } from './herdr/client.js'
import { extractProgress, readProgress } from './progress.js'

const NBSP = ' '
const CLAUDE_SCREEN = [
  '⏺ I will check the parser first.',
  '',
  '⏺ Skill(superpowers:writing-plans)',
  `  ⎿ ${NBSP}Successfully loaded skill`,
  '',
  '⏺ Parser tests pass; moving on to the poller and its cadence tests.',
  '',
  '⏺ Reading the pane output via read-only agent.read',
  `  ⎿  $ printf '%s\\n' '{"id":"probe-1"}' | nc -U -w 3 "$SOCK"`,
  '',
  '· Flummoxing… (44s · ↓ 2.3k tokens)',
  '',
  '─'.repeat(80),
  `❯${NBSP}`,
  '─'.repeat(80),
  '  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← 1 agent',
].join('\n')

describe('extractProgress', () => {
  it('picks the last text block, skipping a described Bash call followed by ⎿', () => {
    expect(extractProgress(CLAUDE_SCREEN)).toBe(
      'Parser tests pass; moving on to the poller and its cadence tests.'
    )
  })

  it('skips Name( tool calls', () => {
    const calls = [
      'Bash(npm test)',
      'Agent(review)',
      'Read(src/a.ts)',
      'Update(src/a.ts)',
      'Write(docs/x.md)',
      'Skill(x)',
    ]
    for (const call of calls) {
      expect(extractProgress('⏺ Done with setup.\n\n⏺ ' + call)).toBe('Done with setup.')
      expect(extractProgress('⏺ Done with setup.\n\n⏺ ' + call + '\n  ⎿  ok')).toBe(
        'Done with setup.'
      )
    }
  })

  it('joins continuation lines of a block', () => {
    expect(
      extractProgress('⏺ First part of the\n  sentence continues\n  here.\n\n  Second paragraph.')
    ).toBe('First part of the sentence continues here.')
  })

  it('accepts NBSP after the marker', () => {
    expect(extractProgress(`⏺${NBSP}Working on it.`)).toBe('Working on it.')
  })

  it('returns null when every block is a tool call', () => {
    expect(extractProgress('⏺ Bash(ls)\n  ⎿  a\n⏺ Read(b)\n  ⎿  Read 3 lines')).toBeNull()
  })

  it('falls back to the last non-chrome line without ⏺ blocks', () => {
    const text =
      'building...\ncompiled 12 files\n\n' +
      '─'.repeat(40) +
      '\n❯ npm run dev\n  ⏵⏵ auto mode on (shift+tab to cycle)\n✻ Churned for 4s · done 20:39'
    expect(extractProgress(text)).toBe('compiled 12 files')
  })

  it('never returns prompt lines', () => {
    for (const text of ['❯ suggested command', `❯${NBSP}`, '❯', '╭────╮\n│ > hi │\n╰────╯']) {
      expect(extractProgress(text)).toBeNull()
    }
  })

  it('ignores spinner lines', () => {
    expect(extractProgress('step one\n✢ Thinking… (3s)\n⠋ Loading')).toBe('step one')
  })

  it('returns null for empty output', () => {
    expect(extractProgress('')).toBeNull()
    expect(extractProgress('\n\n  \n')).toBeNull()
  })

  it('caps long text at 280 characters', () => {
    const long = extractProgress('⏺ ' + 'a'.repeat(400))
    expect(long).toHaveLength(280)
    expect(long?.endsWith('…')).toBe(true)
    const emoji = extractProgress('⏺ ' + '😀'.repeat(300)) ?? ''
    expect(emoji).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
    expect(emoji.endsWith('…')).toBe(true)
  })

  it('keeps a list in the first paragraph', () => {
    expect(extractProgress('⏺ Done:\n  - parser\n  - poller')).toBe('Done: - parser - poller')
  })

  it('treats a bare marker as a block without text', () => {
    expect(extractProgress('⏺')).toBeNull()
    expect(extractProgress('npm output\n⏺')).toBeNull()
    expect(extractProgress('⏺ Done.\n\n⏺')).toBe('Done.')
  })
})

describe('readProgress', () => {
  const fakes: FakeHerdr[] = []

  afterEach(async () => {
    for (const fake of fakes.splice(0)) await fake.stop()
  })

  async function startFake(reads: Record<string, string> = {}) {
    const fake = await startFakeHerdr({ snapshot: fakeSnapshot({ agents: [] }), reads })
    fakes.push(fake)
    return fake
  }

  it('sends agent.read with the pinned params', async () => {
    const fake = await startFake({ 'w1:p1': '⏺ Halfway there.' })
    const client = createHerdrClient({ socketPath: fake.socketPath })
    expect(await readProgress(client, 'w1:p1')).toBe('Halfway there.')
    expect(fake.received).toContainEqual({
      method: 'agent.read',
      params: {
        target: 'w1:p1',
        source: 'recent_unwrapped',
        lines: 120,
        format: 'text',
        strip_ansi: true,
      },
    })
  })

  it('returns null for a closed pane', async () => {
    const fake = await startFake()
    const client = createHerdrClient({ socketPath: fake.socketPath })
    expect(await readProgress(client, 'w9:p9')).toBeNull()
  })
})
