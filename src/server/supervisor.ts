import type { BoardView, HerdrConnection } from '../shared/types.js'
import { applyStatusEvent, boardFromSnapshot, toView, type BoardState } from './board.js'
import type { HerdrClient, HerdrSubscription } from './herdr/client.js'
import {
  parseSnapshotResponse,
  parseStreamLine,
  subscribeParams,
  type HerdrSnapshot,
} from './herdr/protocol.js'

export interface SupervisorState {
  herdr: HerdrConnection
  board: BoardView
}

export interface Supervisor {
  start(): void
  stop(): Promise<void>
  current(): SupervisorState
  onChange(listener: (state: SupervisorState) => void): () => void
}

export interface SupervisorOptions {
  client: HerdrClient
  home: string
  now?: () => number
  debounceMs?: number
  reconcileMs?: number
  backoffInitialMs?: number
  backoffMaxMs?: number
  log?: (message: string) => void
}

class StreamFailure extends Error {}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function endedOf(subscription: HerdrSubscription): Promise<'ended'> {
  return subscription.ended.then(() => 'ended' as const)
}

function paneSetKey(snapshot: HerdrSnapshot): string {
  return snapshot.agents
    .map((agent) => agent.paneId)
    .sort()
    .join('\n')
}

export function createSupervisor(opts: SupervisorOptions): Supervisor {
  const { client, home } = opts
  const now = opts.now ?? Date.now
  const debounceMs = opts.debounceMs ?? 100
  const reconcileMs = opts.reconcileMs ?? 60000
  const backoffInitialMs = opts.backoffInitialMs ?? 500
  const backoffMaxMs = opts.backoffMaxMs ?? 5000
  const log = opts.log ?? ((message: string) => console.error(message))

  let board: BoardState = { cards: new Map() }
  let herdr: HerdrConnection = 'disconnected'
  let state: SupervisorState = { herdr, board: toView(board) }
  let serialized = JSON.stringify(state)
  const listeners = new Set<(state: SupervisorState) => void>()

  let running: Promise<void> | null = null
  let stopped = false
  let subscription: HerdrSubscription | null = null
  let snapshotDue = false
  let outageLogged = false
  let backoff = backoffInitialMs
  let streamFailed = false
  let snapshotInFlight = false
  let eventsDuringSnapshot = false
  let wake: (() => void) | null = null
  let debounceTimer: NodeJS.Timeout | null = null
  let reconcileTimer: NodeJS.Timeout | null = null
  let sleepTimer: NodeJS.Timeout | null = null
  let sleepDone: (() => void) | null = null

  function publish(): void {
    state = { herdr, board: toView(board) }
    const next = JSON.stringify(state)
    if (next === serialized) return
    serialized = next
    for (const listener of [...listeners]) {
      try {
        listener(state)
      } catch {
        continue
      }
    }
  }

  function setConnection(next: HerdrConnection): void {
    herdr = next
    publish()
  }

  function signal(): void {
    const resolve = wake
    wake = null
    resolve?.()
  }

  function waitForSignal(): Promise<'signal'> {
    return new Promise((resolve) => {
      if (snapshotDue || streamFailed || stopped) {
        resolve('signal')
        return
      }
      wake = () => resolve('signal')
    })
  }

  function scheduleSnapshot(): void {
    if (debounceTimer !== null || stopped) return
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      snapshotDue = true
      signal()
    }, debounceMs)
  }

  function armReconcile(): void {
    if (reconcileTimer !== null) clearTimeout(reconcileTimer)
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null
      snapshotDue = true
      signal()
    }, reconcileMs)
  }

  function clearTimers(): void {
    if (debounceTimer !== null) clearTimeout(debounceTimer)
    if (reconcileTimer !== null) clearTimeout(reconcileTimer)
    if (sleepTimer !== null) clearTimeout(sleepTimer)
    debounceTimer = null
    reconcileTimer = null
    sleepTimer = null
    const done = sleepDone
    sleepDone = null
    done?.()
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (stopped) {
        resolve()
        return
      }
      sleepDone = resolve
      sleepTimer = setTimeout(() => {
        sleepTimer = null
        sleepDone = null
        resolve()
      }, ms)
    })
  }

  async function takeSnapshot(): Promise<HerdrSnapshot> {
    snapshotDue = false
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    eventsDuringSnapshot = false
    snapshotInFlight = true
    let snapshot: HerdrSnapshot
    try {
      snapshot = parseSnapshotResponse(await client.request('session.snapshot', {}))
    } finally {
      snapshotInFlight = false
    }
    if (stopped) return snapshot
    board = boardFromSnapshot(board, snapshot, now(), home)
    herdr = 'connected'
    outageLogged = false
    armReconcile()
    publish()
    if (eventsDuringSnapshot && !snapshotDue) scheduleSnapshot()
    return snapshot
  }

  function handleLine(line: string, owner: HerdrSubscription | null): void {
    try {
      if (stopped || owner !== subscription) return
      const item = parseStreamLine(line)
      if (snapshotInFlight && (item.kind === 'status' || item.kind === 'topology')) {
        eventsDuringSnapshot = true
      }
      if (item.kind === 'status') {
        if (board.cards.has(item.paneId)) {
          board = applyStatusEvent(board, item, now())
          publish()
        } else {
          scheduleSnapshot()
        }
      } else if (item.kind === 'started') {
        backoff = backoffInitialMs
        scheduleSnapshot()
      } else if (item.kind === 'topology') {
        scheduleSnapshot()
      } else if (item.kind === 'error') {
        streamFailed = true
        signal()
      }
    } catch {
      streamFailed = true
      signal()
    }
  }

  function openSubscription(snapshot: HerdrSnapshot): HerdrSubscription {
    const paneIds = snapshot.agents.map((agent) => agent.paneId)
    let opened: HerdrSubscription | null = null
    const pending: string[] = []
    opened = client.subscribe(subscribeParams(paneIds), (line) => {
      if (opened === null) pending.push(line)
      else handleLine(line, opened)
    })
    subscription = opened
    for (const line of pending) handleLine(line, opened)
    return opened
  }

  function closeSubscription(): void {
    const closing = subscription
    subscription = null
    closing?.close()
  }

  async function monitor(initial: HerdrSnapshot): Promise<void> {
    let subscribedKey = paneSetKey(initial)
    let ended = endedOf(openSubscription(initial))
    while (!stopped) {
      const outcome = await Promise.race([ended, waitForSignal()])
      if (stopped) return
      if (outcome === 'ended' || streamFailed) throw new StreamFailure('subscription ended')
      if (!snapshotDue) continue
      const snapshot = await takeSnapshot()
      if (stopped) return
      const key = paneSetKey(snapshot)
      if (key !== subscribedKey) {
        closeSubscription()
        subscribedKey = key
        ended = endedOf(openSubscription(snapshot))
      }
    }
  }

  async function loop(): Promise<void> {
    backoff = backoffInitialMs
    while (!stopped) {
      try {
        const snapshot = await takeSnapshot()
        if (stopped) break
        await monitor(snapshot)
      } catch (error) {
        if (stopped) break
        closeSubscription()
        streamFailed = false
        snapshotDue = false
        if (!outageLogged) log(`Herdr not reachable: ${reasonOf(error)}`)
        outageLogged = true
        setConnection('disconnected')
        await sleep(backoff)
        backoff = Math.min(backoff * 2, backoffMaxMs)
      }
    }
    closeSubscription()
  }

  return {
    start() {
      if (running !== null) return
      stopped = false
      running = loop()
    },
    async stop() {
      stopped = true
      clearTimers()
      closeSubscription()
      signal()
      await running
    },
    current() {
      return state
    },
    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
