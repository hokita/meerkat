import type { AgentStatus } from '../shared/types.js'

export interface PolledPane {
  paneId: string
  status: AgentStatus
}

export interface ProgressPoller {
  sync(panes: readonly PolledPane[]): void
  stop(): void
}

export interface ProgressPollerOptions {
  read: (paneId: string) => Promise<string | null>
  onProgress: (paneId: string, text: string) => void
  intervalMs?: number
}

const DEFAULT_INTERVAL_MS = 10_000

export function createProgressPoller(opts: ProgressPollerOptions): ProgressPoller {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  let known = new Map<string, AgentStatus>()
  const queue = new Set<string>()
  let reading: string | null = null
  let draining = false
  let stopped = false

  async function readOrNull(paneId: string): Promise<string | null> {
    try {
      return await opts.read(paneId)
    } catch {
      return null
    }
  }

  function deliver(paneId: string, text: string): void {
    try {
      opts.onProgress(paneId, text)
    } catch {
      return
    }
  }

  async function drain(): Promise<void> {
    if (draining) return
    draining = true
    try {
      while (!stopped) {
        const next = queue.values().next()
        if (next.done) return
        const paneId = next.value
        queue.delete(paneId)
        if (!known.has(paneId)) continue
        reading = paneId
        const text = await readOrNull(paneId)
        reading = null
        if (stopped) return
        if (text !== null && known.has(paneId)) deliver(paneId, text)
      }
    } finally {
      draining = false
    }
  }

  const timer: NodeJS.Timeout = setInterval(() => {
    for (const [paneId, status] of known) {
      if (status === 'working' && paneId !== reading) queue.add(paneId)
    }
    void drain()
  }, intervalMs)

  return {
    sync(panes) {
      if (stopped) return
      const previous = known
      known = new Map(panes.map((pane) => [pane.paneId, pane.status]))
      for (const [paneId, status] of known) {
        if (previous.get(paneId) !== status) queue.add(paneId)
      }
      void drain()
    },
    stop() {
      stopped = true
      clearInterval(timer)
      queue.clear()
    },
  }
}
