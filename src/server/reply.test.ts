import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { HerdrConnection, Prompt } from '../shared/types.js'
import { HerdrTimeoutError } from './herdr/client.js'
import { HerdrProtocolError } from './herdr/protocol.js'
import type { ReplyKey } from '../shared/types.js'
import type { ReplySender } from './herdr/reply-sender.js'
import type { PromptRead } from './read-prompt.js'
import {
  MAX_BODY_BYTES,
  REPLY_MEMORY_MAX,
  REPLY_MEMORY_MS,
  createReplyMemory,
  handleReply,
  readBody,
  serveReply,
  type ReplyDeps,
} from './reply.js'

const PANE = 'w1:p1'
const FP = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)

function option(n: number, label: string, approving = true) {
  return { n, label, description: null, approving }
}

const permission: Prompt = {
  kind: 'permission',
  fingerprint: FP,
  tool: 'Bash command',
  request: 'npm test',
  question: 'Do you want to proceed?',
  options: [option(1, 'Yes'), option(2, "Yes, and don't ask again"), option(3, 'No', false)],
}

const choice: Prompt = {
  kind: 'choice',
  fingerprint: FP,
  header: 'Color',
  question: 'Which color?',
  options: [option(1, 'Red'), option(2, 'Blue'), option(3, 'Type something.')],
  freeTextOption: 3,
}

const choiceWithoutFreeText: Prompt = { ...choice, freeTextOption: null }
const idle: Prompt = { kind: 'idle', fingerprint: FP }
const unrecognized: Prompt = { kind: 'unrecognized', fingerprint: FP }
const none: Prompt = { kind: 'none' }

type Call = [method: 'prompt' | 'sendKeys' | 'sendText', paneId: string, arg: unknown]
type Screen = Prompt | 'gone' | Error

interface Deferred {
  resolve(): void
  promise: Promise<void>
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { resolve, promise }
}

interface SetupOptions {
  screens?: Screen[]
  herdr?: HerdrConnection
  failAt?: { step: number; error: Error }
  gate?: Promise<void>
  bookkeepingThrows?: boolean
}

function setup(opts: SetupOptions = {}) {
  const screens = [...(opts.screens ?? [permission])]
  const calls: Call[] = []
  const reads: string[] = []
  const replies: Array<[string, string]> = []
  const refreshed: string[] = []
  const bookkeeping: string[] = []
  let clock = 1_000_000
  let gate = opts.gate

  function step(call: Call): Promise<void> {
    calls.push(call)
    if (opts.failAt?.step === calls.length) return Promise.reject(opts.failAt.error)
    return Promise.resolve()
  }

  const sender: ReplySender = {
    prompt: (paneId, text) => step(['prompt', paneId, text]),
    sendKeys: (paneId, keys: readonly ReplyKey[]) => step(['sendKeys', paneId, [...keys]]),
    sendText: (paneId, text) => step(['sendText', paneId, text]),
  }

  const deps: ReplyDeps = {
    supervisor: {
      current: () => ({
        herdr: opts.herdr ?? 'connected',
        board: { attention: [], working: [], idle: [] },
      }),
      recordReply: (paneId, summary) => {
        replies.push([paneId, summary])
        bookkeeping.push(`reply ${paneId}`)
        if (opts.bookkeepingThrows === true) throw new Error('record failed')
      },
      markSent: (paneId) => {
        bookkeeping.push(`sent ${paneId}`)
        if (opts.bookkeepingThrows === true) throw new Error('mark failed')
      },
      refreshProgress: (paneId) => {
        refreshed.push(paneId)
        if (opts.bookkeepingThrows === true) throw new Error('refresh failed')
      },
    },
    read: async (paneId): Promise<PromptRead | 'gone'> => {
      reads.push(paneId)
      const waiting = gate
      gate = undefined
      if (waiting !== undefined) await waiting
      const next = screens.length > 1 ? screens.shift() : screens[0]
      if (next === undefined) throw new Error('no screen scripted')
      if (next instanceof Error) throw next
      if (next === 'gone') return 'gone'
      return { text: 'screen', truncated: false, prompt: next }
    },
    sender,
    memory: createReplyMemory(() => clock),
  }

  return {
    deps,
    calls,
    reads,
    replies,
    refreshed,
    bookkeeping,
    advance(ms: number) {
      clock += ms
    },
    show(...next: Screen[]) {
      screens.splice(0, screens.length, ...next)
    },
  }
}

function request(action: unknown, replyId = 'reply-0001', fingerprint = FP): unknown {
  return { replyId, fingerprint, action }
}

describe('handleReply sends', () => {
  it.each<[string, Prompt, unknown, Call[], string]>([
    [
      'option on a permission',
      permission,
      { type: 'option', n: 1 },
      [['sendKeys', PANE, ['1']]],
      'Answered "Yes"',
    ],
    [
      'option on a choice',
      choice,
      { type: 'option', n: 2 },
      [['sendKeys', PANE, ['2']]],
      'Answered "Blue"',
    ],
    [
      'freeText on a choice',
      choice,
      { type: 'freeText', text: '  Medium please ' },
      [
        ['sendKeys', PANE, ['3']],
        ['sendText', PANE, 'Medium please'],
        ['sendKeys', PANE, ['enter']],
      ],
      'Answered "Medium please"',
    ],
    [
      'prompt on idle',
      idle,
      { type: 'prompt', text: 'continue' },
      [['prompt', PANE, 'continue']],
      'Sent "continue"',
    ],
    [
      'one key',
      unrecognized,
      { type: 'keys', keys: ['1'] },
      [['sendKeys', PANE, ['1']]],
      'Pressed 1',
    ],
    [
      'several keys',
      unrecognized,
      { type: 'keys', keys: ['esc', '2', 'enter'] },
      [['sendKeys', PANE, ['esc', '2', 'enter']]],
      'Pressed esc 2 enter',
    ],
    [
      'text',
      unrecognized,
      { type: 'text', text: ' hello ' },
      [['sendText', PANE, 'hello']],
      'Typed "hello"',
    ],
  ])('%s: exactly its sequence', async (_name, prompt, action, expected, summary) => {
    const t = setup({ screens: [prompt] })
    const result = await handleReply(t.deps, PANE, request(action))
    expect(result).toEqual({ status: 200, body: { sent: expected.length } })
    expect(t.calls).toEqual(expected)
    expect(t.reads).toEqual([PANE])
    expect(t.replies).toEqual([[PANE, summary]])
    expect(t.refreshed).toEqual([PANE])
  })

  it('sends a multi-line prompt as one message', async () => {
    const t = setup({ screens: [idle] })
    const result = await handleReply(t.deps, PANE, request({ type: 'prompt', text: 'one\ntwo' }))
    expect(result.status).toBe(200)
    expect(t.calls).toEqual([['prompt', PANE, 'one\ntwo']])
    expect(t.replies).toEqual([[PANE, 'Sent "one two"']])
  })

  it('keeps the summary to 80 characters', async () => {
    const t = setup({ screens: [unrecognized] })
    await handleReply(t.deps, PANE, request({ type: 'text', text: 'x'.repeat(200) }))
    const summary = t.replies[0]?.[1] ?? ''
    expect([...summary]).toHaveLength(80)
    expect(summary.startsWith('Typed "xxx')).toBe(true)
    expect(summary.endsWith('…')).toBe(true)
  })
})

describe('handleReply refuses', () => {
  it('refuses when the fresh fingerprint differs', async () => {
    const fresh: Prompt = { ...permission, fingerprint: OTHER }
    const t = setup({ screens: [fresh] })
    const result = await handleReply(t.deps, PANE, request({ type: 'option', n: 1 }))
    expect(result).toEqual({ status: 409, body: { error: 'prompt_changed', prompt: fresh } })
    expect(t.calls).toEqual([])
    expect(t.replies).toEqual([])
    expect(t.refreshed).toEqual([])
  })

  it.each([
    [{ type: 'option', n: 1 }],
    [{ type: 'prompt', text: 'go' }],
    [{ type: 'keys', keys: ['esc'] }],
    [{ type: 'text', text: 'hi' }],
    [{ type: 'freeText', text: 'hi' }],
  ])('answers 409 not_waiting for %j while working', async (action) => {
    const t = setup({ screens: [none] })
    const result = await handleReply(t.deps, PANE, request(action))
    expect(result).toEqual({ status: 409, body: { error: 'not_waiting' } })
    expect(t.calls).toEqual([])
  })

  it.each<[string, Prompt, unknown]>([
    ['option 4 of 3', permission, { type: 'option', n: 4 }],
    ['the type-your-own number as an option', choice, { type: 'option', n: 3 }],
    ['freeText without a freeTextOption', choiceWithoutFreeText, { type: 'freeText', text: 'hi' }],
    ['freeText on a permission', permission, { type: 'freeText', text: 'hi' }],
    ['prompt on a blocked permission', permission, { type: 'prompt', text: 'go' }],
    ['prompt on a choice', choice, { type: 'prompt', text: 'go' }],
    ['prompt on unrecognized', unrecognized, { type: 'prompt', text: 'go' }],
    ['keys on a permission', permission, { type: 'keys', keys: ['1'] }],
    ['text on a choice', choice, { type: 'text', text: 'hi' }],
    ['option on idle', idle, { type: 'option', n: 1 }],
    ['keys on idle', idle, { type: 'keys', keys: ['enter'] }],
    ['option on unrecognized', unrecognized, { type: 'option', n: 1 }],
  ])('answers 400 invalid_action for %s', async (_name, prompt, action) => {
    const t = setup({ screens: [prompt] })
    const result = await handleReply(t.deps, PANE, request(action))
    expect(result).toEqual({ status: 400, body: { error: 'invalid_action' } })
    expect(t.calls).toEqual([])
  })

  it.each([
    ['empty keys', request({ type: 'keys', keys: [] })],
    ['a newline outside prompt', request({ type: 'text', text: 'a\nb' })],
    ['text over 4000 characters', request({ type: 'prompt', text: 'x'.repeat(4001) })],
    ['blank text', request({ type: 'prompt', text: '   ' })],
    ['a control character', request({ type: 'freeText', text: 'a\u001bb' })],
    ['a bad fingerprint', request({ type: 'option', n: 1 }, 'reply-0001', 'nope')],
    ['not an object', 'option 1'],
  ])('answers 400 invalid_body for %s without reading', async (_name, body) => {
    const t = setup()
    const result = await handleReply(t.deps, PANE, body)
    expect(result).toEqual({ status: 400, body: { error: 'invalid_body' } })
    expect(t.reads).toEqual([])
    expect(t.calls).toEqual([])
  })

  it('answers 404 session_closed when the session is gone', async () => {
    const t = setup({ screens: ['gone'] })
    const result = await handleReply(t.deps, PANE, request({ type: 'option', n: 1 }))
    expect(result).toEqual({ status: 404, body: { error: 'session_closed' } })
    expect(t.calls).toEqual([])
  })
})

describe('handleReply Herdr errors', () => {
  it('reports agent_blocked as 502 herdr_error', async () => {
    const t = setup({
      screens: [idle],
      failAt: { step: 1, error: new HerdrProtocolError('agent_blocked', 'blocked') },
    })
    const result = await handleReply(t.deps, PANE, request({ type: 'prompt', text: 'go' }))
    expect(result).toEqual({
      status: 502,
      body: { error: 'herdr_error', code: 'agent_blocked', sent: 0 },
    })
    expect(t.replies).toEqual([])
    expect(t.refreshed).toEqual([])
  })

  it('stops a freeText failing at step 2 and reports sent: 1', async () => {
    const t = setup({
      screens: [choice],
      failAt: { step: 2, error: new HerdrProtocolError('pane_not_found', 'gone') },
    })
    const result = await handleReply(t.deps, PANE, request({ type: 'freeText', text: 'hi' }))
    expect(result).toEqual({
      status: 502,
      body: { error: 'herdr_error', code: 'pane_not_found', sent: 1 },
    })
    expect(t.calls).toEqual([
      ['sendKeys', PANE, ['3']],
      ['sendText', PANE, 'hi'],
    ])
    expect(t.replies).toEqual([])
    expect(t.refreshed).toEqual([PANE])
  })

  it('replays a partial freeText failure without pressing the number again', async () => {
    const t = setup({
      screens: [choice],
      failAt: { step: 2, error: new HerdrProtocolError('pane_not_found', 'gone') },
    })
    const first = await handleReply(t.deps, PANE, request({ type: 'freeText', text: 'hi' }))
    const second = await handleReply(t.deps, PANE, request({ type: 'freeText', text: 'hi' }))
    expect(second).toEqual(first)
    expect(t.calls).toHaveLength(2)
    expect(t.reads).toHaveLength(1)
  })

  it('keeps the send result when bookkeeping throws', async () => {
    const t = setup({ screens: [unrecognized], bookkeepingThrows: true })
    const first = await handleReply(t.deps, PANE, request({ type: 'keys', keys: ['1'] }))
    expect(first).toEqual({ status: 200, body: { sent: 1 } })
    const second = await handleReply(t.deps, PANE, request({ type: 'keys', keys: ['1'] }))
    expect(second).toEqual(first)
    expect(t.calls).toEqual([['sendKeys', PANE, ['1']]])
    expect(t.refreshed).toEqual([PANE])
  })

  it.each<[string, Error, string]>([
    ['a socket close', new Error('socket closed'), 'unknown'],
    ['a timeout', new HerdrTimeoutError(500), 'unknown'],
    ['a malformed answer', new HerdrProtocolError('malformed', 'bad'), 'malformed'],
  ])('reports %s during a send as uncertain', async (_name, error, code) => {
    const t = setup({ failAt: { step: 1, error } })
    const result = await handleReply(t.deps, PANE, request({ type: 'option', n: 1 }))
    expect(result).toEqual({
      status: 502,
      body: { error: 'herdr_error', code, sent: 0, uncertain: true },
    })
    expect(t.refreshed).toEqual([PANE])
    expect(t.bookkeeping).toEqual([`sent ${PANE}`])
    expect(t.replies).toEqual([])
  })

  it('reports a failed fresh read as 502 without sending', async () => {
    const t = setup({ screens: [new HerdrProtocolError('timeout', 'slow')] })
    const result = await handleReply(t.deps, PANE, request({ type: 'option', n: 1 }))
    expect(result).toEqual({
      status: 502,
      body: { error: 'herdr_error', code: 'timeout', sent: 0 },
    })
    expect(t.calls).toEqual([])
  })
})

describe('handleReply marks sends', () => {
  it('bumps the epoch before recording the reply after a successful send', async () => {
    const t = setup({ screens: [permission] })
    await handleReply(t.deps, PANE, request({ type: 'option', n: 1 }))
    expect(t.bookkeeping).toEqual([`sent ${PANE}`, `reply ${PANE}`])
  })

  it('bumps the epoch after a partial send without recording a reply', async () => {
    const t = setup({
      screens: [choice],
      failAt: { step: 2, error: new HerdrProtocolError('pane_not_found', 'gone') },
    })
    await handleReply(t.deps, PANE, request({ type: 'freeText', text: 'hi' }))
    expect(t.bookkeeping).toEqual([`sent ${PANE}`])
  })

  it('does not bump the epoch when nothing was sent', async () => {
    const t = setup({
      screens: [idle],
      failAt: { step: 1, error: new HerdrProtocolError('agent_blocked', 'blocked') },
    })
    await handleReply(t.deps, PANE, request({ type: 'prompt', text: 'go' }))
    expect(t.bookkeeping).toEqual([])
  })
})

describe('handleReply replay and lock', () => {
  it('returns the stored result for the same replyId without sending again', async () => {
    const t = setup({ screens: [permission, { ...permission, fingerprint: OTHER }] })
    const first = await handleReply(t.deps, PANE, request({ type: 'option', n: 1 }))
    const second = await handleReply(t.deps, PANE, request({ type: 'option', n: 1 }))
    expect(first).toEqual({ status: 200, body: { sent: 1 } })
    expect(second).toEqual(first)
    expect(t.calls).toHaveLength(1)
    expect(t.reads).toHaveLength(1)
    expect(t.replies).toHaveLength(1)
  })

  it('replays a refusal for the same replyId', async () => {
    const fresh: Prompt = { ...permission, fingerprint: OTHER }
    const t = setup({ screens: [fresh] })
    const first = await handleReply(t.deps, PANE, request({ type: 'option', n: 1 }))
    t.show(permission)
    const second = await handleReply(t.deps, PANE, request({ type: 'option', n: 1 }))
    expect(second).toEqual(first)
    expect(t.calls).toEqual([])
  })

  it('keeps reply ids per pane', async () => {
    const t = setup({ screens: [permission] })
    await handleReply(t.deps, PANE, request({ type: 'option', n: 1 }))
    await handleReply(t.deps, 'w2:p1', request({ type: 'option', n: 1 }))
    expect(t.calls).toEqual([
      ['sendKeys', PANE, ['1']],
      ['sendKeys', 'w2:p1', ['1']],
    ])
  })

  it('forgets a replyId after 5 minutes', async () => {
    const t = setup({ screens: [permission] })
    await handleReply(t.deps, PANE, request({ type: 'option', n: 1 }))
    t.advance(REPLY_MEMORY_MS - 1)
    await handleReply(t.deps, PANE, request({ type: 'option', n: 1 }))
    expect(t.calls).toHaveLength(1)
    t.advance(1)
    await handleReply(t.deps, PANE, request({ type: 'option', n: 1 }))
    expect(t.calls).toHaveLength(2)
  })

  it('runs two concurrent requests on one pane one after the other', async () => {
    const gate = deferred()
    const t = setup({
      screens: [permission, { ...permission, fingerprint: OTHER }],
      gate: gate.promise,
    })
    const first = handleReply(t.deps, PANE, request({ type: 'option', n: 1 }, 'reply-aaaa'))
    const second = handleReply(t.deps, PANE, request({ type: 'option', n: 3 }, 'reply-bbbb'))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(t.reads).toHaveLength(1)
    gate.resolve()
    expect(await first).toEqual({ status: 200, body: { sent: 1 } })
    expect((await second).status).toBe(409)
    expect(t.reads).toHaveLength(2)
    expect(t.calls).toEqual([['sendKeys', PANE, ['1']]])
  })

  it('sends once for two concurrent requests with the same replyId', async () => {
    const gate = deferred()
    const t = setup({ screens: [permission], gate: gate.promise })
    const first = handleReply(t.deps, PANE, request({ type: 'option', n: 1 }))
    const second = handleReply(t.deps, PANE, request({ type: 'option', n: 1 }))
    gate.resolve()
    expect(await second).toEqual(await first)
    expect(t.calls).toHaveLength(1)
  })

  it('does not block other panes while one pane is locked', async () => {
    const gate = deferred()
    const t = setup({ screens: [permission], gate: gate.promise })
    const first = handleReply(t.deps, PANE, request({ type: 'option', n: 1 }))
    const other = await handleReply(t.deps, 'w2:p1', request({ type: 'option', n: 1 }))
    expect(other.status).toBe(200)
    gate.resolve()
    expect((await first).status).toBe(200)
  })

  it('releases the lock after a failure', async () => {
    const t = setup({ screens: [new Error('boom'), permission] })
    expect(
      (await handleReply(t.deps, PANE, request({ type: 'option', n: 1 }, 'reply-aaaa'))).status
    ).toBe(502)
    expect(
      (await handleReply(t.deps, PANE, request({ type: 'option', n: 1 }, 'reply-bbbb'))).status
    ).toBe(200)
  })
})

function incoming(chunks: Array<string | Buffer>): Readable {
  return Readable.from(
    chunks.map((chunk) => (typeof chunk === 'string' ? Buffer.from(chunk) : chunk))
  )
}

describe('serveReply', () => {
  const json = JSON.stringify(request({ type: 'option', n: 1 }))

  it('reads the body and answers', async () => {
    const t = setup()
    const result = await serveReply(t.deps, incoming([json.slice(0, 10), json.slice(10)]), PANE)
    expect(result).toEqual({ status: 200, body: { sent: 1 } })
  })

  it('decodes a percent-encoded pane id', async () => {
    const t = setup()
    const result = await serveReply(t.deps, incoming([json]), 'w1%3Ap1')
    expect(result.status).toBe(200)
    expect(t.calls).toEqual([['sendKeys', PANE, ['1']]])
  })

  it.each(['nope', 'w1:p1:p2', '%E0%A4%A', 'w1%2Fp1'])(
    'answers 400 invalid_pane_id for %j',
    async (raw) => {
      const t = setup()
      const result = await serveReply(t.deps, incoming([json]), raw)
      expect(result).toEqual({ status: 400, body: { error: 'invalid_pane_id' } })
      expect(t.reads).toEqual([])
    }
  )

  it.each<HerdrConnection>(['disconnected', 'connecting'])(
    'answers 503 herdr_unreachable while %s',
    async (herdr) => {
      const t = setup({ herdr })
      const result = await serveReply(t.deps, incoming([json]), PANE)
      expect(result).toEqual({ status: 503, body: { error: 'herdr_unreachable' } })
      expect(t.reads).toEqual([])
      expect(t.calls).toEqual([])
    }
  )

  it('answers 400 invalid_body for malformed JSON', async () => {
    const t = setup()
    const result = await serveReply(t.deps, incoming(['{"replyId":']), PANE)
    expect(result).toEqual({ status: 400, body: { error: 'invalid_body' } })
  })

  it('accepts a body of exactly 8 KB', async () => {
    const t = setup()
    const padded = json + ' '.repeat(MAX_BODY_BYTES - Buffer.byteLength(json))
    const result = await serveReply(t.deps, incoming([padded]), PANE)
    expect(result.status).toBe(200)
  })

  it('answers 413 for a body over 8 KB without reading the pane', async () => {
    const t = setup()
    const padded = json + ' '.repeat(MAX_BODY_BYTES + 1 - Buffer.byteLength(json))
    const result = await serveReply(
      t.deps,
      incoming([padded.slice(0, 4000), padded.slice(4000)]),
      PANE
    )
    expect(result).toEqual({ status: 413, body: { error: 'body_too_large' } })
    expect(t.reads).toEqual([])
    expect(t.calls).toEqual([])
  })
})

describe('createReplyMemory', () => {
  const ok = { status: 200, body: { sent: 1 } }

  it(`keeps at most ${REPLY_MEMORY_MAX} results, dropping the oldest first`, () => {
    const memory = createReplyMemory(() => 0)
    for (let i = 0; i <= REPLY_MEMORY_MAX; i += 1) memory.remember(PANE, `reply-${i}`, ok)
    expect(memory.recall(PANE, 'reply-0')).toBeUndefined()
    expect(memory.recall(PANE, 'reply-1')).toEqual(ok)
    expect(memory.recall(PANE, `reply-${REPLY_MEMORY_MAX}`)).toEqual(ok)
  })

  it('expires on the monotonic clock by default', () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
    try {
      const memory = createReplyMemory()
      memory.remember(PANE, 'reply-0001', ok)
      clock.mockReturnValue(REPLY_MEMORY_MS - 1)
      expect(memory.recall(PANE, 'reply-0001')).toEqual(ok)
      clock.mockReturnValue(REPLY_MEMORY_MS)
      expect(memory.recall(PANE, 'reply-0001')).toBeUndefined()
    } finally {
      clock.mockRestore()
    }
  })
})

describe('readBody', () => {
  it('rejects when the request closes before it ends', async () => {
    const req = new Readable({ read: () => undefined })
    const reading = readBody(req, MAX_BODY_BYTES)
    req.push(Buffer.from('{"replyId":'))
    req.destroy()
    await expect(reading).rejects.toThrow('request closed before the body ended')
  })
})
