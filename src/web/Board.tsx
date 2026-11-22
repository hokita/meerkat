import type { BoardView, Card } from '../shared/types'
import { CardView } from './Card'

interface BoardProps {
  board: BoardView
  now: number
  stale: boolean
  onOpen: (paneId: string) => void
}

interface ColumnProps {
  title: string
  cards: Card[]
  now: number
  stale: boolean
  onOpen: (paneId: string) => void
}

function ColumnView({ title, cards, now, stale, onOpen }: ColumnProps) {
  const headingId = `column-${title.replace(/\s+/g, '-').toLowerCase()}`
  return (
    <section className="column" aria-labelledby={headingId}>
      <h2 className="column-heading">
        <span id={headingId}>{title}</span>
        <span className="badge">{cards.length}</span>
      </h2>
      <div className="column-cards">
        {cards.length === 0 && <p className="empty">Nothing here</p>}
        {cards.map((card) => (
          <CardView key={card.paneId} card={card} now={now} stale={stale} onOpen={onOpen} />
        ))}
      </div>
    </section>
  )
}

export function Board({ board, now, stale, onOpen }: BoardProps) {
  return (
    <div className="board">
      <ColumnView
        title="Waiting for you"
        cards={board.waiting}
        now={now}
        stale={stale}
        onOpen={onOpen}
      />
      <ColumnView title="Done" cards={board.done} now={now} stale={stale} onOpen={onOpen} />
      <ColumnView title="Working" cards={board.working} now={now} stale={stale} onOpen={onOpen} />
      <ColumnView title="Idle" cards={board.idle} now={now} stale={stale} onOpen={onOpen} />
    </div>
  )
}
