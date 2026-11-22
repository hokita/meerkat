import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Card, Prompt } from '../shared/types.js'
import type { HerdrClient } from './herdr/client.js'
import type { ReplySender } from './herdr/reply-sender.js'
import { readPrompt } from './read-prompt.js'
import { createReplyMemory, handleReply, type ReplyDeps } from './reply.js'

const PANE = 'w1:p1'

function screen(name: string): string {
  return readFileSync(new URL(`../../test-support/screens/${name}`, import.meta.url), 'utf8')
}

function card(status: Card['status'], statusEpoch: number): Card {
  return {
    paneId: PANE,
    workspaceId: 'w1',
    name: null,
    repo: 'repo',
    title: null,
    status,
    since: 1,
    sinceIsLowerBound: false,
    progress: null,
    agent: 'claude',
    terminalId: 't1',
    statusEpoch,
    lastReply: null,
  }
}

function readLine(text: string): string {
  return JSON.stringify({
    id: 'x',
    result: { type: 'pane_read', read: { text, truncated: false } },
  })
}

type Screens = (params: Record<string, unknown>, holder: { card: Card | undefined }) => string

function setup(start: Card, screens: Screens) {
  const holder: { card: Card | undefined } = { card: start }
  const sent: unknown[] = []
  let race = false
  const client: HerdrClient = {
    request(_method, params) {
      const p = params as Record<string, unknown>
      return Promise.resolve(screens(p, race ? holder : { card: holder.card }))
    },
    subscribe() {
      throw new Error('unused')
    },
  }
  const opts = { client, supervisor: { card: () => holder.card } }
  const record = (call: unknown) => {
    sent.push(call)
    return Promise.resolve()
  }
  const sender: ReplySender = {
    prompt: (paneId, text) => record(['prompt', paneId, text]),
    sendKeys: (paneId, keys) => record(['sendKeys', paneId, [...keys]]),
    sendText: (paneId, text) => record(['sendText', paneId, text]),
  }
  const deps: ReplyDeps = {
    supervisor: {
      current: () => ({
        herdr: 'connected',
        board: { waiting: [], done: [], working: [], idle: [] },
      }),
      recordReply: () => undefined,
      markSent: () => undefined,
      refreshProgress: () => undefined,
    },
    read: (paneId) => readPrompt(opts, paneId),
    sender,
    memory: createReplyMemory(() => 0),
  }
  async function shown(): Promise<Prompt> {
    const read = await readPrompt(opts, PANE)
    if (typeof read === 'string') throw new Error(read)
    race = true
    return read.prompt
  }
  return { deps, sent, shown }
}

function fingerprintOf(prompt: Prompt): string {
  if (prompt.kind === 'none') throw new Error('not waiting')
  return prompt.fingerprint
}

describe('handleReply when the card moves on during the fresh read', () => {
  it('refuses without sending when blocked turns working during the screen read', async () => {
    const t = setup(card('blocked', 1), (_p, holder) => {
      holder.card = card('working', 2)
      return readLine(screen('permission-bash.txt'))
    })
    const fingerprint = fingerprintOf(await t.shown())
    const result = await handleReply(t.deps, PANE, {
      replyId: 'reply-0001',
      fingerprint,
      action: { type: 'option', n: 1 },
    })
    expect(result).toEqual({ status: 409, body: { error: 'session_changed' } })
    expect(t.sent).toEqual([])
  })

  it('refuses without sending when idle turns done during the ANSI read', async () => {
    const suggestion = screen('idle-suggestion.txt').replace(
      'ls -la made-by-bash.txt',
      'run the tests again'
    )
    const t = setup(card('idle', 1), (p, holder) => {
      if (p['format'] !== 'ansi') return readLine(suggestion)
      holder.card = card('done', 2)
      return readLine(screen('idle-suggestion.ansi.txt'))
    })
    const prompt = await t.shown()
    expect(prompt.kind).toBe('idle')
    const result = await handleReply(t.deps, PANE, {
      replyId: 'reply-0002',
      fingerprint: fingerprintOf(prompt),
      action: { type: 'prompt', text: 'hello' },
    })
    expect(result).toEqual({ status: 409, body: { error: 'session_changed' } })
    expect(t.sent).toEqual([])
  })
})
