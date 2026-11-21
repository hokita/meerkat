import { useState } from 'react'
import { Banners } from './Banners'
import { Board } from './Board'
import { useNow } from './elapsed'
import { useMeerkatStream } from './useMeerkatStream'

export function App() {
  const { board, herdr, stream } = useMeerkatStream()
  const now = useNow()
  const [, setOpenPaneId] = useState<string | null>(null)
  const stale = herdr === 'disconnected' || stream === 'lost'

  return (
    <>
      <header className="app-header">
        <h1>Meerkat</h1>
      </header>
      <Banners herdr={herdr} stream={stream} />
      {board !== null && <Board board={board} now={now} stale={stale} onOpen={setOpenPaneId} />}
    </>
  )
}
