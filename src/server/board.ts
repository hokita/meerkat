import type { AgentStatus, BoardView, Card, Column } from '../shared/types.js'
import type { HerdrSnapshot, HerdrWorkspace } from './herdr/protocol.js'

export interface BoardState {
  readonly cards: ReadonlyMap<string, Card>
  readonly nextEpoch: number
}

const UNKNOWN_REPO = '(unknown)'
const UNNAMED = '(unnamed)'
export const REPLY_VISIBLE_MS = 600_000

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

function supersedesReply(card: Card): boolean {
  if (card.lastReply === null || card.statusEpoch <= card.lastReply.epoch) return false
  return card.status === 'blocked' || card.status === 'idle' || card.status === 'done'
}

function withoutSupersededReply(card: Card): Card {
  return supersedesReply(card) ? { ...card, lastReply: null } : card
}

export function boardFromSnapshot(
  prev: BoardState | null,
  snap: HerdrSnapshot,
  now: number,
  home: string
): BoardState {
  const workspaces = new Map(snap.workspaces.map((workspace) => [workspace.workspaceId, workspace]))
  const cards = new Map<string, Card>()
  let nextEpoch = prev?.nextEpoch ?? 0
  for (const agent of snap.agents) {
    const previous = prev?.cards.get(agent.paneId)
    const unchanged = previous !== undefined && previous.status === agent.status
    const card: Card = {
      paneId: agent.paneId,
      workspaceId: agent.workspaceId,
      name: agent.name,
      repo: repoName(agent.cwd, workspaces.get(agent.workspaceId), home),
      title: agent.terminalTitle,
      status: agent.status,
      since: unchanged ? previous.since : now,
      sinceIsLowerBound: unchanged ? previous.sinceIsLowerBound : true,
      progress: previous?.progress ?? null,
      agent: agent.agent,
      terminalId: agent.terminalId,
      statusEpoch: unchanged ? previous.statusEpoch : nextEpoch++,
      lastReply: previous?.lastReply ?? null,
    }
    cards.set(agent.paneId, unchanged ? card : withoutSupersededReply(card))
  }
  return { cards, nextEpoch }
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
      ? withoutSupersededReply({
          ...card,
          title,
          status: ev.status,
          since: now,
          sinceIsLowerBound: false,
          statusEpoch: state.nextEpoch,
        })
      : { ...card, title }
  )
  return { cards, nextEpoch: statusChanged ? state.nextEpoch + 1 : state.nextEpoch }
}

export function applyProgress(
  state: BoardState,
  paneId: string,
  text: string,
  now: number
): BoardState {
  const card = state.cards.get(paneId)
  if (card === undefined || card.progress?.text === text) return state
  const cards = new Map(state.cards)
  cards.set(paneId, {
    ...card,
    progress: { text, since: now, sinceIsLowerBound: card.progress === null },
  })
  return { ...state, cards }
}

export function applyReply(
  state: BoardState,
  paneId: string,
  summary: string,
  now: number
): BoardState {
  const card = state.cards.get(paneId)
  if (card === undefined) return state
  const cards = new Map(state.cards)
  cards.set(paneId, { ...card, lastReply: { summary, at: now, epoch: card.statusEpoch } })
  return { ...state, cards }
}

export function bumpEpoch(state: BoardState, paneId: string): BoardState {
  const card = state.cards.get(paneId)
  if (card === undefined) return state
  const cards = new Map(state.cards)
  cards.set(paneId, { ...card, statusEpoch: state.nextEpoch })
  return { cards, nextEpoch: state.nextEpoch + 1 }
}

export function expireReplies(state: BoardState, now: number): BoardState {
  const expired = [...state.cards.values()].filter(
    (card) => card.lastReply !== null && now - card.lastReply.at >= REPLY_VISIBLE_MS
  )
  if (expired.length === 0) return state
  const cards = new Map(state.cards)
  for (const card of expired) cards.set(card.paneId, { ...card, lastReply: null })
  return { ...state, cards }
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
