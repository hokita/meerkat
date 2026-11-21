import type { AgentStatus, BoardView, Card, Column } from '../shared/types.js'
import type { HerdrSnapshot, HerdrWorkspace } from './herdr/protocol.js'

export interface BoardState {
  readonly cards: ReadonlyMap<string, Card>
}

const UNKNOWN_REPO = '(unknown)'
const UNNAMED = '(unnamed)'

export function columnOf(status: AgentStatus): Column {
  if (status === 'done' || status === 'blocked') return 'attention'
  if (status === 'working') return 'working'
  return 'idle'
}

export function repoName(
  cwd: string | null,
  workspace: HerdrWorkspace | undefined,
  home: string
): string {
  if (workspace?.repoName) return workspace.repoName
  if (cwd === null) return UNKNOWN_REPO
  const segments = cwd.split('/').filter((segment) => segment !== '')
  const worktreesRoot = `${home.replace(/\/+$/, '')}/.herdr/worktrees/`
  if (cwd.startsWith(worktreesRoot)) {
    const [repo] = cwd.slice(worktreesRoot.length).split('/')
    if (repo) return repo
  }
  return segments[segments.length - 1] ?? UNKNOWN_REPO
}

export function boardFromSnapshot(
  prev: BoardState | null,
  snap: HerdrSnapshot,
  now: number,
  home: string
): BoardState {
  const workspaces = new Map(snap.workspaces.map((workspace) => [workspace.workspaceId, workspace]))
  const cards = new Map<string, Card>()
  for (const agent of snap.agents) {
    const previous = prev?.cards.get(agent.paneId)
    const unchanged = previous !== undefined && previous.status === agent.status
    cards.set(agent.paneId, {
      paneId: agent.paneId,
      workspaceId: agent.workspaceId,
      name: agent.name,
      repo: repoName(agent.cwd, workspaces.get(agent.workspaceId), home),
      title: agent.terminalTitle,
      status: agent.status,
      since: unchanged ? previous.since : now,
      sinceIsLowerBound: unchanged ? previous.sinceIsLowerBound : true,
    })
  }
  return { cards }
}

export function applyStatusEvent(
  state: BoardState,
  ev: { paneId: string; status: AgentStatus; title?: string | null },
  now: number
): BoardState {
  const card = state.cards.get(ev.paneId)
  if (card === undefined) return state
  const statusChanged = card.status !== ev.status
  const title = ev.title === undefined ? card.title : ev.title
  if (!statusChanged && title === card.title) return state
  const cards = new Map(state.cards)
  cards.set(
    ev.paneId,
    statusChanged
      ? { ...card, title, status: ev.status, since: now, sinceIsLowerBound: false }
      : { ...card, title }
  )
  return { cards }
}

function bySince(a: Card, b: Card): number {
  return a.since - b.since || compareText(a.paneId, b.paneId)
}

function byName(a: Card, b: Card): number {
  return compareText(a.name ?? UNNAMED, b.name ?? UNNAMED) || compareText(a.paneId, b.paneId)
}

function compareText(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}

export function toView(state: BoardState): BoardView {
  const view: BoardView = { attention: [], working: [], idle: [] }
  for (const card of state.cards.values()) view[columnOf(card.status)].push(card)
  view.attention.sort(bySince)
  view.working.sort(bySince)
  view.idle.sort(byName)
  return view
}
