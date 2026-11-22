import { useState } from 'react'
import type { BoardView, Card } from '../shared/types'
import { Banners } from './Banners'
import { Board } from './Board'
import { useNow } from './elapsed'
import { OutputDrawer } from './OutputDrawer'
import { useMeerkatStream } from './useMeerkatStream'

function findCard(board: BoardView | null, paneId: string | null): Card | null {
  if (board === null || paneId === null) return null
  const all = [...board.waiting, ...board.done, ...board.working, ...board.idle]
  return all.find((card) => card.paneId === paneId) ?? null
}

export function App() {
  const { board, herdr, stream } = useMeerkatStream()
  const now = useNow()
  const [openPaneId, setOpenPaneId] = useState<string | null>(null)
  const stale = herdr === 'disconnected' || stream === 'lost'

  return (
    <>
      <header className="app-header">
        <h1>Meerkat</h1>
      </header>
      <Banners herdr={herdr} stream={stream} />
      {board !== null && <Board board={board} now={now} stale={stale} onOpen={setOpenPaneId} />}
      {openPaneId !== null && (
        <OutputDrawer
          key={openPaneId}
          paneId={openPaneId}
          card={findCard(board, openPaneId)}
          onClose={() => setOpenPaneId(null)}
          herdrConnected={herdr === 'connected' && stream !== 'lost'}
        />
      )}
    </>
  )
}
