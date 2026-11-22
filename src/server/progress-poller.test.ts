import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProgressPoller, type ProgressPoller } from './progress-poller.js'

interface Deferred {
  resolve: (value: string | null) => void
  reject: (error: Error) => void
  promise: Promise<string | null>
}

function deferred(): Deferred {
  let resolve!: (value: string | null) => void
  let reject!: (error: Error) => void
  const promise = new Promise<string | null>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { resolve, reject, promise }
}

function setup() {
  const calls: string[] = []
  const pending: Deferred[] = []
  const progress: Array<[string, string]> = []
  const poller = createProgressPoller({
    read: (paneId) => {
      calls.push(paneId)
      const d = deferred()
      pending.push(d)
      return d.promise
    },
    onProgress: (paneId, text) => progress.push([paneId, text]),
  })
  return { poller, calls, pending, progress }
}

const settle = () => vi.advanceTimersByTimeAsync(0)

describe('createProgressPoller', () => {
  let active: ProgressPoller | undefined

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    active?.stop()
    active = undefined
    vi.useRealTimers()
  })

  it('reads every pane on first sync', async () => {
    const { poller, calls, pending, progress } = setup()
    active = poller
    poller.sync([
      { paneId: 'a', status: 'working' },
      { paneId: 'b', status: 'idle' },
    ])
    await settle()
    expect(calls).toEqual(['a'])
    pending[0]!.resolve('text a')
    await settle()
    expect(calls).toEqual(['a', 'b'])
    pending[1]!.resolve('text b')
    await settle()
    expect(progress).toEqual([
      ['a', 'text a'],
      ['b', 'text b'],
    ])
  })

  it('re-reads working panes every 10 s, not idle ones', async () => {
    const { poller, calls, pending } = setup()
    active = poller
    poller.sync([
      { paneId: 'a', status: 'working' },
      { paneId: 'b', status: 'idle' },
    ])
    await settle()
    pending[0]!.resolve('x')
    await settle()
    pending[1]!.resolve('y')
    await settle()
    expect(calls).toEqual(['a', 'b'])

    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls).toEqual(['a', 'b', 'a'])
    pending[2]!.resolve('x')
    await settle()

    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls).toEqual(['a', 'b', 'a', 'a'])
  })

  it('reads a pane when its status changes', async () => {
    const { poller, calls, pending } = setup()
    active = poller
    poller.sync([
      { paneId: 'a', status: 'working' },
      { paneId: 'b', status: 'idle' },
    ])
    await settle()
    pending[0]!.resolve('x')
    await settle()
    pending[1]!.resolve('y')
    await settle()

    poller.sync([
      { paneId: 'a', status: 'working' },
      { paneId: 'b', status: 'done' },
    ])
    await settle()
    expect(calls).toEqual(['a', 'b', 'b'])
    pending[2]!.resolve('z')
    await settle()

    poller.sync([
      { paneId: 'a', status: 'working' },
      { paneId: 'b', status: 'done' },
    ])
    await settle()
    expect(calls).toEqual(['a', 'b', 'b'])
  })

  it('never has two reads in flight', async () => {
    const { poller, calls, pending } = setup()
    active = poller
    poller.sync(
      Array.from({ length: 60 }, (_, i) => ({ paneId: `p${i}`, status: 'working' as const }))
    )
    let maxOpen = 0
    for (let i = 0; i < 60; i += 1) {
      await settle()
      maxOpen = Math.max(maxOpen, calls.length - i)
      pending[i]!.resolve('t')
      await settle()
    }
    expect(maxOpen).toBe(1)
    expect(calls).toHaveLength(60)
  })

  it('does not pile up reads during a slow read', async () => {
    const { poller, calls, pending } = setup()
    active = poller
    poller.sync([{ paneId: 'a', status: 'working' }])
    await settle()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(calls).toEqual(['a'])
    pending[0]!.resolve('x')
    await settle()
    expect(calls.length).toBeLessThanOrEqual(2)
  })

  it('skips null and failed reads', async () => {
    const { poller, calls, pending, progress } = setup()
    active = poller
    poller.sync([
      { paneId: 'a', status: 'working' },
      { paneId: 'b', status: 'working' },
      { paneId: 'c', status: 'working' },
    ])
    await settle()
    pending[0]!.resolve(null)
    await settle()
    pending[1]!.reject(new Error('boom'))
    await settle()
    expect(calls).toEqual(['a', 'b', 'c'])
    expect(progress).toEqual([])
    pending[2]!.resolve('ok')
    await settle()
    expect(progress).toEqual([['c', 'ok']])
  })

  it('drops results for panes removed while reading', async () => {
    const { poller, calls, pending, progress } = setup()
    active = poller
    poller.sync([{ paneId: 'a', status: 'working' }])
    await settle()
    poller.sync([])
    pending[0]!.resolve('late')
    await settle()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(progress).toEqual([])
    expect(calls).toEqual(['a'])
  })

  it('stop halts everything', async () => {
    const { poller, calls, pending, progress } = setup()
    active = poller
    poller.sync([
      { paneId: 'a', status: 'working' },
      { paneId: 'b', status: 'working' },
    ])
    await settle()
    poller.stop()
    pending[0]!.resolve('late')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(progress).toEqual([])
    expect(calls).toEqual(['a'])
  })

  it('keeps one read in flight when onProgress re-syncs with a changed status', async () => {
    const calls: string[] = []
    const pending: Deferred[] = []
    let inFlight = 0
    let maxInFlight = 0
    let resynced = false
    const poller: ProgressPoller = createProgressPoller({
      read: async (paneId) => {
        calls.push(paneId)
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        const d = deferred()
        pending.push(d)
        try {
          return await d.promise
        } finally {
          inFlight -= 1
        }
      },
      onProgress: () => {
        if (resynced) return
        resynced = true
        poller.sync([
          { paneId: 'a', status: 'done' },
          { paneId: 'b', status: 'working' },
        ])
      },
    })
    active = poller
    poller.sync([{ paneId: 'a', status: 'working' }])
    await settle()
    pending[0]!.resolve('first')
    await settle()
    expect(maxInFlight).toBe(1)
    expect(calls).toEqual(['a', 'a'])
    pending[1]!.resolve('second')
    await settle()
    expect(calls).toEqual(['a', 'a', 'b'])
    pending[2]!.resolve('third')
    await settle()
    expect(maxInFlight).toBe(1)
    expect(calls).toEqual(['a', 'a', 'b'])
  })

  it('survives a throwing onProgress without an unhandled rejection', async () => {
    const calls: string[] = []
    const pending: Deferred[] = []
    const unhandled: unknown[] = []
    const record = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', record)
    try {
      const poller = createProgressPoller({
        read: (paneId) => {
          calls.push(paneId)
          const d = deferred()
          pending.push(d)
          return d.promise
        },
        onProgress: () => {
          throw new Error('listener failed')
        },
      })
      active = poller
      poller.sync([
        { paneId: 'a', status: 'working' },
        { paneId: 'b', status: 'working' },
      ])
      await settle()
      pending[0]!.resolve('x')
      await settle()
      expect(calls).toEqual(['a', 'b'])
      pending[1]!.resolve('y')
      await settle()
      await vi.advanceTimersByTimeAsync(1)
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', record)
    }
  })

  it('reads a pane again when its status changes during its read', async () => {
    const { poller, calls, pending } = setup()
    active = poller
    poller.sync([{ paneId: 'a', status: 'working' }])
    await settle()
    poller.sync([{ paneId: 'a', status: 'done' }])
    await settle()
    expect(calls).toEqual(['a'])
    pending[0]!.resolve('stale')
    await settle()
    expect(calls).toEqual(['a', 'a'])
    pending[1]!.resolve('fresh')
    await settle()
    expect(calls).toEqual(['a', 'a'])
  })
})
