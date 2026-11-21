import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fakeAgent,
  fakeSnapshot,
  startFakeHerdr,
  type FakeHerdr,
} from '../../test-support/fake-herdr.js'
import { ALLOWED_METHODS } from './herdr/allowlist.js'
import { createHerdrClient, type HerdrClient } from './herdr/client.js'
import { createSupervisor, type Supervisor, type SupervisorState } from './supervisor.js'

const TIMINGS = { debounceMs: 5, backoffInitialMs: 10, backoffMaxMs: 40, reconcileMs: 200 }
const HOME = '/Users/u'

const supervisors: Supervisor[] = []
const fakes: FakeHerdr[] = []
const allReceived: string[] = []

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) await supervisor.stop()
  for (const fake of fakes.splice(0)) {
    await fake.stop()
    allReceived.push(...fake.received.map((request) => request.method))
  }
})

async function startFake(
  agents = [fakeAgent({ pane_id: 'wJ:p1' }), fakeAgent({ pane_id: 'wK:p1' })]
) {
  const fake = await startFakeHerdr({ snapshot: fakeSnapshot({ agents }) })
  fakes.push(fake)
  return fake
}

function supervise(
  client: HerdrClient,
  overrides: Partial<Parameters<typeof createSupervisor>[0]> = {}
) {
  const supervisor = createSupervisor({ client, home: HOME, ...TIMINGS, ...overrides })
  supervisors.push(supervisor)
  return supervisor
}

function methods(fake: FakeHerdr): string[] {
  return fake.received.map((request) => request.method)
}

function count(fake: FakeHerdr, method: string): number {
  return methods(fake).filter((m) => m === method).length
}

function paneIds(state: SupervisorState): string[] {
  return [...state.board.attention, ...state.board.working, ...state.board.idle]
    .map((card) => card.paneId)
    .sort()
}

function subscribedPanes(fake: FakeHerdr, index: number): string[] {
  const subscribes = fake.received.filter((request) => request.method === 'events.subscribe')
  const params = subscribes[index]?.params as { subscriptions: { pane_id?: string }[] }
  return params.subscriptions.flatMap((s) => (s.pane_id ? [s.pane_id] : [])).sort()
}

describe('supervisor', () => {
  it('starts disconnected with an empty board', () => {
    const supervisor = supervise(createHerdrClient({ socketPath: '/nonexistent/h.sock' }))
    expect(supervisor.current()).toEqual({
      herdr: 'disconnected',
      board: { attention: [], working: [], idle: [] },
    })
  })

  it('connects, builds the board, snapshots then subscribes once for every agent pane', async () => {
    const fake = await startFake()
    const supervisor = supervise(createHerdrClient({ socketPath: fake.socketPath }))
    supervisor.start()
    await vi.waitFor(() => expect(supervisor.current().herdr).toBe('connected'))
    await vi.waitFor(() => expect(count(fake, 'events.subscribe')).toBe(1))
    expect(paneIds(supervisor.current())).toEqual(['wJ:p1', 'wK:p1'])
    expect(methods(fake)).toEqual(['session.snapshot', 'events.subscribe'])
    expect(subscribedPanes(fake, 0)).toEqual(['wJ:p1', 'wK:p1'])
  })

  it('moves a card to attention on a status event and notifies', async () => {
    const fake = await startFake()
    const supervisor = supervise(createHerdrClient({ socketPath: fake.socketPath }))
    const seen: SupervisorState[] = []
    supervisor.onChange((state) => seen.push(state))
    supervisor.start()
    await vi.waitFor(() => expect(count(fake, 'events.subscribe')).toBe(1))
    fake.pushStatus('wJ:p1', 'done')
    await vi.waitFor(() =>
      expect(supervisor.current().board.attention.map((c) => c.paneId)).toEqual(['wJ:p1'])
    )
    expect(seen.at(-1)?.board.attention).toHaveLength(1)
  })

  it('does not notify when nothing changed and survives a throwing listener', async () => {
    const fake = await startFake()
    const supervisor = supervise(createHerdrClient({ socketPath: fake.socketPath }))
    const seen: SupervisorState[] = []
    supervisor.onChange(() => {
      throw new Error('listener failure')
    })
    supervisor.onChange((state) => seen.push(state))
    supervisor.start()
    await vi.waitFor(() => expect(count(fake, 'events.subscribe')).toBe(1))
    const before = seen.length
    fake.pushStatus('wJ:p1', 'idle')
    fake.pushRaw('not json')
    fake.pushStatus('wJ:p1', 'done')
    await vi.waitFor(() => expect(seen.length).toBe(before + 1))
    expect(supervisor.current().herdr).toBe('connected')
  })

  it('stops notifying a listener once unsubscribed', async () => {
    const fake = await startFake()
    const supervisor = supervise(createHerdrClient({ socketPath: fake.socketPath }))
    const listener = vi.fn()
    const unsubscribe = supervisor.onChange(listener)
    unsubscribe()
    supervisor.start()
    await vi.waitFor(() => expect(supervisor.current().herdr).toBe('connected'))
    expect(listener).not.toHaveBeenCalled()
  })

  it('re-snapshots and re-subscribes when a status arrives for an unknown pane', async () => {
    const fake = await startFake()
    const supervisor = supervise(createHerdrClient({ socketPath: fake.socketPath }))
    supervisor.start()
    await vi.waitFor(() => expect(count(fake, 'events.subscribe')).toBe(1))
    fake.setSnapshot(
      fakeSnapshot({
        agents: [
          fakeAgent({ pane_id: 'wJ:p1' }),
          fakeAgent({ pane_id: 'wK:p1' }),
          fakeAgent({ pane_id: 'wL:p1' }),
        ],
      })
    )
    fake.pushStatus('wL:p1', 'working')
    await vi.waitFor(() => expect(count(fake, 'events.subscribe')).toBe(2))
    expect(count(fake, 'session.snapshot')).toBe(2)
    expect(subscribedPanes(fake, 1)).toEqual(['wJ:p1', 'wK:p1', 'wL:p1'])
    expect(paneIds(supervisor.current())).toEqual(['wJ:p1', 'wK:p1', 'wL:p1'])
    expect(supervisor.current().herdr).toBe('connected')
  })

  it('re-snapshots and re-subscribes on a topology event', async () => {
    const fake = await startFake()
    const supervisor = supervise(createHerdrClient({ socketPath: fake.socketPath }))
    supervisor.start()
    await vi.waitFor(() => expect(count(fake, 'events.subscribe')).toBe(1))
    fake.setSnapshot(
      fakeSnapshot({
        agents: [fakeAgent({ pane_id: 'wJ:p1' }), fakeAgent({ pane_id: 'wM:p1' })],
      })
    )
    fake.pushRaw('{"event":"pane_created","data":{"type":"pane_created"}}')
    await vi.waitFor(() => expect(count(fake, 'events.subscribe')).toBe(2))
    expect(subscribedPanes(fake, 1)).toEqual(['wJ:p1', 'wM:p1'])
    expect(paneIds(supervisor.current())).toEqual(['wJ:p1', 'wM:p1'])
  })

  it('collapses a burst of topology events into one extra snapshot', async () => {
    const fake = await startFake()
    const supervisor = supervise(createHerdrClient({ socketPath: fake.socketPath }), {
      debounceMs: 30,
    })
    supervisor.start()
    await vi.waitFor(() => expect(count(fake, 'events.subscribe')).toBe(1))
    for (let i = 0; i < 3; i += 1) fake.pushRaw('{"event":"pane_created","data":{}}')
    await vi.waitFor(() => expect(count(fake, 'session.snapshot')).toBe(2))
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(count(fake, 'session.snapshot')).toBe(2)
    expect(count(fake, 'events.subscribe')).toBe(1)
  })

  it('recovers after Herdr restarts mid-stream', async () => {
    const fake = await startFake()
    const supervisor = supervise(createHerdrClient({ socketPath: fake.socketPath }))
    supervisor.start()
    await vi.waitFor(() => expect(count(fake, 'events.subscribe')).toBe(1))
    await fake.stop()
    await vi.waitFor(() => expect(supervisor.current().herdr).toBe('disconnected'))
    expect(paneIds(supervisor.current())).toEqual(['wJ:p1', 'wK:p1'])
    fake.setSnapshot(fakeSnapshot({ agents: [fakeAgent({ pane_id: 'wZ:p1' })] }))
    await fake.restart()
    await vi.waitFor(() => expect(supervisor.current().herdr).toBe('connected'))
    expect(paneIds(supervisor.current())).toEqual(['wZ:p1'])
    await vi.waitFor(() => expect(subscribedPanes(fake, 1)).toEqual(['wZ:p1']))
  })

  it('stays disconnected while Herdr is absent, backing off up to the cap, then connects', async () => {
    const fake = await startFake()
    await fake.stop()
    const real = createHerdrClient({ socketPath: fake.socketPath })
    const attempts: number[] = []
    const client: HerdrClient = {
      request(method, params) {
        attempts.push(performance.now())
        return real.request(method, params)
      },
      subscribe: (params, onLine) => real.subscribe(params, onLine),
    }
    const supervisor = supervise(client)
    supervisor.start()
    await vi.waitFor(() => expect(attempts.length).toBeGreaterThanOrEqual(6))
    expect(supervisor.current().herdr).toBe('disconnected')
    const gaps = attempts.slice(1).map((time, i) => time - (attempts[i] ?? 0))
    expect(gaps[0]).toBeLessThan(gaps[3] ?? 0)
    for (const gap of gaps) expect(gap).toBeLessThan(40 + 100)
    expect(gaps.at(-1)).toBeGreaterThanOrEqual(35)
    await fake.restart()
    await vi.waitFor(() => expect(supervisor.current().herdr).toBe('connected'))
  })

  it('treats a stream error item as a disconnect and recovers', async () => {
    const fake = await startFake()
    const supervisor = supervise(createHerdrClient({ socketPath: fake.socketPath }))
    const connections: string[] = []
    supervisor.onChange((state) => connections.push(state.herdr))
    supervisor.start()
    await vi.waitFor(() => expect(count(fake, 'events.subscribe')).toBe(1))
    fake.pushRaw('{"error":{"code":"internal","message":"boom"}}')
    await vi.waitFor(() => expect(count(fake, 'events.subscribe')).toBe(2))
    expect(connections).toEqual(['connected', 'disconnected', 'connected'])
  })

  it('does not flicker to disconnected when it re-subscribes deliberately', async () => {
    const fake = await startFake()
    const supervisor = supervise(createHerdrClient({ socketPath: fake.socketPath }))
    const connections: string[] = []
    supervisor.onChange((state) => connections.push(state.herdr))
    supervisor.start()
    await vi.waitFor(() => expect(count(fake, 'events.subscribe')).toBe(1))
    fake.setSnapshot(fakeSnapshot({ agents: [fakeAgent({ pane_id: 'wN:p1' })] }))
    fake.pushRaw('{"event":"pane_created","data":{}}')
    await vi.waitFor(() => expect(count(fake, 'events.subscribe')).toBe(2))
    await vi.waitFor(() => expect(paneIds(supervisor.current())).toEqual(['wN:p1']))
    expect(connections).not.toContain('disconnected')
  })

  it('takes a fresh snapshot every reconcile interval without re-subscribing', async () => {
    const fake = await startFake()
    const supervisor = supervise(createHerdrClient({ socketPath: fake.socketPath }), {
      reconcileMs: 50,
    })
    supervisor.start()
    await vi.waitFor(() => expect(count(fake, 'session.snapshot')).toBeGreaterThanOrEqual(2))
    expect(count(fake, 'events.subscribe')).toBe(1)
    expect(supervisor.current().herdr).toBe('connected')
  })

  it('picks up changes found by reconcile', async () => {
    const fake = await startFake()
    const supervisor = supervise(createHerdrClient({ socketPath: fake.socketPath }), {
      reconcileMs: 50,
    })
    supervisor.start()
    await vi.waitFor(() => expect(count(fake, 'events.subscribe')).toBe(1))
    fake.setSnapshot(fakeSnapshot({ agents: [fakeAgent({ pane_id: 'wQ:p1' })] }))
    await vi.waitFor(() => expect(paneIds(supervisor.current())).toEqual(['wQ:p1']))
    await vi.waitFor(() => expect(count(fake, 'events.subscribe')).toBe(2))
  })

  it('stop closes the subscription and makes no further requests', async () => {
    const fake = await startFake()
    const supervisor = supervise(createHerdrClient({ socketPath: fake.socketPath }), {
      reconcileMs: 20,
    })
    supervisor.start()
    await vi.waitFor(() => expect(count(fake, 'events.subscribe')).toBe(1))
    await supervisor.stop()
    const total = fake.received.length
    const connections = fake.connectionCount
    fake.pushStatus('wJ:p1', 'done')
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(fake.received.length).toBe(total)
    expect(fake.connectionCount).toBe(connections)
  })

  it('stop while Herdr is absent resolves and stops retrying', async () => {
    const fake = await startFake()
    await fake.stop()
    const real = createHerdrClient({ socketPath: fake.socketPath })
    let attempts = 0
    const client: HerdrClient = {
      request(method, params) {
        attempts += 1
        return real.request(method, params)
      },
      subscribe: (params, onLine) => real.subscribe(params, onLine),
    }
    const supervisor = supervise(client, { backoffInitialMs: 5000, backoffMaxMs: 5000 })
    supervisor.start()
    await vi.waitFor(() => expect(attempts).toBe(1))
    await supervisor.stop()
    const settled = attempts
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(attempts).toBe(settled)
  })

  it('only ever asks Herdr for allow-listed methods', () => {
    expect(allReceived.length).toBeGreaterThan(0)
    for (const method of allReceived) expect(ALLOWED_METHODS.has(method)).toBe(true)
  })
})
