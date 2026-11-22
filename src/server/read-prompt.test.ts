import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Card } from '../shared/types.js'
import type { HerdrClient } from './herdr/client.js'
import { readPrompt } from './read-prompt.js'

function screen(name: string): string {
  return readFileSync(new URL(`../../test-support/screens/${name}`, import.meta.url), 'utf8')
}

function suggestionScreen(): string {
  return screen('idle-suggestion.txt').replace('ls -la made-by-bash.txt', 'run the tests again')
}

function card(status: Card['status'], agent: string | null = 'claude'): Card {
  return {
    paneId: 'w1:p1',
    workspaceId: 'w1',
    name: null,
    repo: 'repo',
    title: null,
    status,
    since: 1,
    sinceIsLowerBound: false,
    progress: null,
    agent,
    terminalId: 't1',
    statusEpoch: 3,
    lastReply: null,
  }
}

type Responder = (params: Record<string, unknown>) => string

function readLine(text: string, truncated = false): string {
  return JSON.stringify({
    id: 'x',
    result: { type: 'pane_read', read: { text, truncated } },
  })
}

function errorLine(code: string): string {
  return JSON.stringify({ id: 'x', error: { code, message: code } })
}

function setup(current: Card | undefined, respond: Responder) {
  const calls: Record<string, unknown>[] = []
  const client: HerdrClient = {
    request(_method, params) {
      const p = params as Record<string, unknown>
      calls.push(p)
      return Promise.resolve(respond(p))
    },
    subscribe() {
      throw new Error('unused')
    },
  }
  const holder = { card: current }
  const supervisor = { card: () => holder.card }
  return { opts: { client, supervisor }, calls, holder }
}

function moved(status: Card['status'], change: Partial<Card> = {}): Card {
  return { ...card(status), statusEpoch: 4, ...change }
}

describe('readPrompt', () => {
  it('returns gone without reading when there is no card', async () => {
    const { opts, calls } = setup(undefined, () => readLine(''))
    expect(await readPrompt(opts, 'w1:p1')).toBe('gone')
    expect(calls).toEqual([])
  })

  it('returns gone when Herdr no longer knows the pane', async () => {
    const { opts } = setup(card('blocked'), () => errorLine('agent_not_found'))
    expect(await readPrompt(opts, 'w1:p1')).toBe('gone')
  })

  it('recognizes a permission prompt from a 120-line read with a fingerprint', async () => {
    const { opts, calls } = setup(card('blocked'), () => readLine(screen('permission-bash.txt')))
    const result = await readPrompt(opts, 'w1:p1')
    if (typeof result === 'string') throw new Error(result)
    expect(result.prompt.kind).toBe('permission')
    expect(result.prompt.kind === 'permission' && result.prompt.fingerprint).toMatch(
      /^[0-9a-f]{64}$/
    )
    expect(result.text.split('\n').length).toBeLessThanOrEqual(40)
    expect(calls).toEqual([
      {
        target: 'w1:p1',
        source: 'recent_unwrapped',
        lines: 120,
        format: 'text',
        strip_ansi: true,
      },
    ])
  })

  it('returns none for a working card', async () => {
    const { opts } = setup(card('working'), () => readLine(screen('permission-bash.txt')))
    const result = await readPrompt(opts, 'w1:p1')
    if (typeof result === 'string') throw new Error(result)
    expect(result.prompt).toEqual({ kind: 'none' })
  })

  it('retries once with the visible source on agent_not_idle', async () => {
    const { opts, calls } = setup(card('blocked'), (p) =>
      p['source'] === 'visible'
        ? readLine(screen('permission-bash.txt'))
        : errorLine('agent_not_idle')
    )
    const result = await readPrompt(opts, 'w1:p1')
    if (typeof result === 'string') throw new Error(result)
    expect(result.prompt.kind).toBe('permission')
    expect(calls[1]).toEqual({
      target: 'w1:p1',
      source: 'visible',
      format: 'text',
      strip_ansi: true,
    })
  })

  it('propagates a second failure', async () => {
    const { opts } = setup(card('blocked'), () => errorLine('agent_not_idle'))
    await expect(readPrompt(opts, 'w1:p1')).rejects.toMatchObject({ code: 'agent_not_idle' })
  })

  it('uses the ANSI read to accept a faint idle suggestion', async () => {
    const { opts, calls } = setup(card('idle'), (p) =>
      p['format'] === 'ansi'
        ? readLine(screen('idle-suggestion.ansi.txt'))
        : readLine(suggestionScreen())
    )
    const result = await readPrompt(opts, 'w1:p1')
    if (typeof result === 'string') throw new Error(result)
    expect(result.prompt.kind).toBe('idle')
    expect(calls[1]).toEqual({
      target: 'w1:p1',
      source: 'visible',
      format: 'ansi',
      strip_ansi: false,
    })
  })

  it('keeps unrecognized when the ANSI read fails', async () => {
    const { opts } = setup(card('idle'), (p) =>
      p['format'] === 'ansi' ? errorLine('boom') : readLine(suggestionScreen())
    )
    const result = await readPrompt(opts, 'w1:p1')
    if (typeof result === 'string') throw new Error(result)
    expect(result.prompt.kind).toBe('unrecognized')
  })

  it('keeps unrecognized when the pane vanishes during the ANSI read', async () => {
    const { opts } = setup(card('idle'), (p) =>
      p['format'] === 'ansi' ? errorLine('agent_not_found') : readLine(suggestionScreen())
    )
    const result = await readPrompt(opts, 'w1:p1')
    if (typeof result === 'string') throw new Error(result)
    expect(result.prompt.kind).toBe('unrecognized')
  })

  it('returns the last 40 lines and flags truncation when there are more', async () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
    const { opts } = setup(card('idle'), () => readLine(text))
    const result = await readPrompt(opts, 'w1:p1')
    if (typeof result === 'string') throw new Error(result)
    const lines = result.text.split('\n')
    expect(lines).toHaveLength(40)
    expect(lines.at(-1)).toBe('line 99')
    expect(result.truncated).toBe(true)
  })

  it('answers changed when the status epoch moves during the screen read', async () => {
    const { opts, holder } = setup(card('blocked'), () => {
      holder.card = moved('working')
      return readLine(screen('permission-bash.txt'))
    })
    expect(await readPrompt(opts, 'w1:p1')).toBe('changed')
  })

  it('answers changed when the terminal changes during the screen read', async () => {
    const { opts, holder } = setup(card('blocked'), () => {
      holder.card = { ...card('blocked'), terminalId: 't2' }
      return readLine(screen('permission-bash.txt'))
    })
    expect(await readPrompt(opts, 'w1:p1')).toBe('changed')
  })

  it('answers changed when the status epoch moves during the ANSI read', async () => {
    const { opts, holder } = setup(card('idle'), (p) => {
      if (p['format'] !== 'ansi') return readLine(suggestionScreen())
      holder.card = moved('done')
      return readLine(screen('idle-suggestion.ansi.txt'))
    })
    expect(await readPrompt(opts, 'w1:p1')).toBe('changed')
  })

  it('answers gone when the card disappears during the screen read', async () => {
    const { opts, holder } = setup(card('blocked'), () => {
      holder.card = undefined
      return readLine(screen('permission-bash.txt'))
    })
    expect(await readPrompt(opts, 'w1:p1')).toBe('gone')
  })
})
