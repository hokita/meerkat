export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

export type Column = 'attention' | 'working' | 'idle'

export interface Progress {
  text: string
  since: number
  sinceIsLowerBound: boolean
}

export interface Card {
  paneId: string
  workspaceId: string
  name: string | null
  repo: string
  title: string | null
  status: AgentStatus
  since: number
  sinceIsLowerBound: boolean
  progress: Progress | null
}

export interface BoardView {
  attention: Card[]
  working: Card[]
  idle: Card[]
}

export type HerdrConnection = 'connecting' | 'connected' | 'disconnected'
