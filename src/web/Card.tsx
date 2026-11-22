import type { Card } from '../shared/types'
import { formatElapsed } from './elapsed'

interface CardViewProps {
  card: Card
  now: number
  stale?: boolean
  onOpen: (paneId: string) => void
}

export function CardView({ card, now, stale = false, onOpen }: CardViewProps) {
  return (
    <button
      type="button"
      className="card"
      aria-disabled={stale ? 'true' : undefined}
      onClick={() => onOpen(card.paneId)}
    >
      <span className="card-name">{card.name ?? '(unnamed)'}</span>
      <span className="card-repo">{card.repo}</span>
      {card.title !== null && <span className="card-title">{card.title}</span>}
      {card.progress !== null && (
        <>
          <span className="card-progress">{card.progress.text}</span>
          <span className="card-progress-age">
            updated {formatElapsed(now - card.progress.since, card.progress.sinceIsLowerBound)} ago
          </span>
        </>
      )}
      <span className="card-workspace">{card.workspaceId}</span>
      <span className="card-footer">
        <span className={`pill pill-${card.status}`}>{card.status}</span>
        <span className="card-elapsed">
          {formatElapsed(now - card.since, card.sinceIsLowerBound)}
        </span>
      </span>
    </button>
  )
}
