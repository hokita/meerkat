export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

export type Column = 'attention' | 'working' | 'idle'

export interface Card {
  paneId: string
  workspaceId: string
  name: string | null
  repo: string
  title: string | null
  status: AgentStatus
  since: number
  sinceIsLowerBound: boolean
}

export interface BoardView {
  attention: Card[]
  working: Card[]
  idle: Card[]
}

export type HerdrConnection = 'connecting' | 'connected' | 'disconnected'
