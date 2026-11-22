import { useEffect, useState } from 'react'
import type { BoardView, HerdrConnection } from '../shared/types'

export type StreamState = 'connecting' | 'open' | 'lost'

export interface MeerkatStream {
  board: BoardView | null
  herdr: HerdrConnection | null
  stream: StreamState
}

const EVENT_SOURCE_CLOSED = 2
const RECREATE_INITIAL_MS = 1000
const RECREATE_MAX_MS = 10_000

function parse(event: Event): unknown {
  try {
    return JSON.parse((event as MessageEvent<string>).data)
  } catch {
    return undefined
  }
}

export function useMeerkatStream(url = '/api/events'): MeerkatStream {
  const [board, setBoard] = useState<BoardView | null>(null)
  const [herdr, setHerdr] = useState<HerdrConnection | null>(null)
  const [stream, setStream] = useState<StreamState>('connecting')

  useEffect(() => {
    let source: EventSource | null = null
    let recreateTimer: ReturnType<typeof setTimeout> | null = null
    let delay = RECREATE_INITIAL_MS

    function connect(): void {
      const current = new globalThis.EventSource(url)
      source = current
      current.addEventListener('open', () => {
        delay = RECREATE_INITIAL_MS
        setStream('open')
      })
      current.addEventListener('error', () => {
        setStream('lost')
        if (current.readyState === EVENT_SOURCE_CLOSED && recreateTimer === null) {
          recreateTimer = setTimeout(() => {
            recreateTimer = null
            connect()
          }, delay)
          delay = Math.min(delay * 2, RECREATE_MAX_MS)
        }
      })
      current.addEventListener('board', (event) => {
        const data = parse(event)
        if (data !== undefined && data !== null) setBoard(data as BoardView)
      })
      current.addEventListener('connection', (event) => {
        const data = parse(event) as { herdr?: HerdrConnection } | undefined | null
        if (data?.herdr !== undefined) setHerdr(data.herdr)
      })
    }

    connect()
    return () => {
      if (recreateTimer !== null) clearTimeout(recreateTimer)
      recreateTimer = null
      source?.close()
    }
  }, [url])

  return { board, herdr, stream }
}
