import { useEffect, useRef, useState } from 'react'
import type { Card } from '../shared/types'

type OutputStatus = 'ok' | 'closed' | 'unreachable' | 'error'

interface OutputState {
  paneId: string
  status: OutputStatus
  text: string | null
  truncated: boolean
}

interface OutputDrawerProps {
  paneId: string
  card: Card | null
  onClose: () => void
  fetchOutput?: (paneId: string) => Promise<Response>
}

function defaultFetchOutput(paneId: string): Promise<Response> {
  return fetch('/api/sessions/' + encodeURIComponent(paneId) + '/output')
}

function statusFor(response: Response): OutputStatus {
  if (response.ok) return 'ok'
  if (response.status === 404) return 'closed'
  if (response.status === 503) return 'unreachable'
  return 'error'
}

async function loadOutput(
  fetchOutput: (paneId: string) => Promise<Response>,
  paneId: string
): Promise<OutputState> {
  try {
    const response = await fetchOutput(paneId)
    const status = statusFor(response)
    if (status !== 'ok') return { paneId, status, text: null, truncated: false }
    const body = (await response.json()) as { text: string; truncated: boolean }
    return { paneId, status, text: body.text, truncated: body.truncated }
  } catch {
    return { paneId, status: 'error', text: null, truncated: false }
  }
}

function messageFor(card: Card | null, current: OutputState | null): string | null {
  if (card === null || current?.status === 'closed') return 'Session closed'
  if (current === null) return 'Loading…'
  if (current.status === 'unreachable') return 'Herdr is not reachable'
  if (current.status === 'error') return 'Could not load output'
  return null
}

export function OutputDrawer({
  paneId,
  card,
  onClose,
  fetchOutput = defaultFetchOutput,
}: OutputDrawerProps) {
  const [state, setState] = useState<OutputState | null>(null)
  const [reloads, setReloads] = useState(0)
  const [lastCard, setLastCard] = useState<Card | null>(card)
  const scrollRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  if (card !== null && card !== lastCard) setLastCard(card)

  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    void loadOutput(fetchOutput, paneId).then((result) => {
      if (!cancelled) setState((previous) => merge(previous, result))
    })
    return () => {
      cancelled = true
    }
  }, [paneId, fetchOutput, reloads])

  const current = state !== null && state.paneId === paneId ? state : null
  const text = current?.text ?? null

  useEffect(() => {
    const element = scrollRef.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [text])

  const name = lastCard?.name ?? '(unnamed)'
  const message = messageFor(card, current)
  const refreshDisabled = card === null || current?.status === 'closed'

  return (
    <div className="drawer-backdrop">
      <aside className="drawer" role="dialog" aria-label={`Output for ${name}`}>
        <header className="drawer-header">
          <div className="drawer-heading">
            <span className="drawer-name">{name}</span>
            {lastCard !== null && <span className="drawer-repo">{lastCard.repo}</span>}
          </div>
          <button
            type="button"
            className="drawer-button"
            disabled={refreshDisabled}
            onClick={() => setReloads((count) => count + 1)}
          >
            Refresh
          </button>
          <button type="button" className="drawer-button" ref={closeRef} onClick={onClose}>
            Close
          </button>
        </header>
        {message !== null && <p className="drawer-message">{message}</p>}
        {current?.truncated === true && <p className="drawer-note">Showing the last 40 lines</p>}
        <div className="drawer-scroll" ref={scrollRef}>
          {text !== null && <pre className="drawer-output">{text}</pre>}
        </div>
      </aside>
    </div>
  )
}

function merge(previous: OutputState | null, result: OutputState): OutputState {
  if (result.status === 'ok' || previous === null || previous.paneId !== result.paneId) {
    return result
  }
  return { ...result, text: previous.text, truncated: previous.truncated }
}
