import { useEffect, useState } from 'react'
import type { BoardView, HerdrConnection } from '../shared/types'

export type StreamState = 'connecting' | 'open' | 'lost'

export interface MeerkatStream {
  board: BoardView | null
  herdr: HerdrConnection | null
  stream: StreamState
}

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
    const source = new globalThis.EventSource(url)
    source.addEventListener('open', () => setStream('open'))
    source.addEventListener('error', () => setStream('lost'))
    source.addEventListener('board', (event) => {
      const data = parse(event)
      if (data !== undefined && data !== null) setBoard(data as BoardView)
    })
    source.addEventListener('connection', (event) => {
      const data = parse(event) as { herdr?: HerdrConnection } | undefined | null
      if (data?.herdr !== undefined) setHerdr(data.herdr)
    })
    return () => source.close()
  }, [url])

  return { board, herdr, stream }
}
