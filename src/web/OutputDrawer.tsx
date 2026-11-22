import { useEffect, useRef, useState } from 'react'
import type { Card, Prompt, ReplyRequest } from '../shared/types'
import { ReplyPanel } from './ReplyPanel'
import type { ReplyResult } from './replyApi'

type OutputStatus = 'ok' | 'closed' | 'unreachable' | 'error'

interface OutputState {
  paneId: string
  status: OutputStatus
  text: string | null
  truncated: boolean
  prompt: Prompt
  generation: number
}

const NO_PROMPT: Prompt = { kind: 'none' }

interface OutputDrawerProps {
  paneId: string
  card: Card | null
  onClose: () => void
  fetchOutput?: (paneId: string) => Promise<Response>
  herdrConnected?: boolean
  send?: (paneId: string, request: ReplyRequest) => Promise<ReplyResult>
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

function promptOf(value: unknown): Prompt {
  const valid =
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)['kind'] === 'string'
  return valid ? (value as Prompt) : NO_PROMPT
}

async function loadOutput(
  fetchOutput: (paneId: string) => Promise<Response>,
  paneId: string,
  generation: number
): Promise<OutputState> {
  const failed = (status: OutputStatus): OutputState => ({
    paneId,
    status,
    text: null,
    truncated: false,
    prompt: NO_PROMPT,
    generation,
  })
  try {
    const response = await fetchOutput(paneId)
    const status = statusFor(response)
    if (status !== 'ok') return failed(status)
    const body = (await response.json()) as { text: string; truncated: boolean; prompt?: unknown }
    return {
      paneId,
      status,
      text: body.text,
      truncated: body.truncated,
      prompt: promptOf(body.prompt),
      generation,
    }
  } catch {
    return failed('error')
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
  herdrConnected = false,
  send,
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
    void loadOutput(fetchOutput, paneId, reloads).then((result) => {
      if (!cancelled) setState((previous) => merge(previous, result))
    })
    return () => {
      cancelled = true
    }
  }, [paneId, fetchOutput, reloads])

  const current = state !== null && state.paneId === paneId ? state : null
  const text = current?.text ?? null
  const outputFirst = current?.prompt.kind === 'unrecognized'

  useEffect(() => {
    const element = scrollRef.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [text, outputFirst])

  const name = lastCard?.name ?? '(unnamed)'
  const message = messageFor(card, current)
  const refreshDisabled = card === null || current?.status === 'closed'
  const loading = current === null || current.generation !== reloads
  const refresh = () => setReloads((count) => count + 1)

  const panel = card !== null && current !== null && (
    <ReplyPanel
      paneId={paneId}
      name={name}
      prompt={current.prompt}
      status={card.status}
      disabled={!herdrConnected || loading}
      onSent={refresh}
      onPromptChanged={(prompt) => {
        setState((previous) => (previous === null ? previous : { ...previous, prompt }))
        refresh()
      }}
      send={send}
    />
  )
  const output = (
    <>
      {current?.truncated === true && <p className="drawer-note">Showing the last 40 lines</p>}
      <div className="drawer-scroll" ref={scrollRef}>
        {text !== null && <pre className="drawer-output">{text}</pre>}
      </div>
    </>
  )

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
            onClick={refresh}
          >
            Refresh
          </button>
          <button type="button" className="drawer-button" ref={closeRef} onClick={onClose}>
            Close
          </button>
        </header>
        {message !== null && <p className="drawer-message">{message}</p>}
        {outputFirst && output}
        {panel}
        {!outputFirst && output}
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
