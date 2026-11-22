export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

export type Column = 'attention' | 'working' | 'idle'

export interface Progress {
  text: string
  since: number
  sinceIsLowerBound: boolean
}

export interface LastReply {
  summary: string
  at: number
  epoch: number
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
  agent: string | null
  terminalId: string | null
  statusEpoch: number
  lastReply: LastReply | null
}

export interface BoardView {
  attention: Card[]
  working: Card[]
  idle: Card[]
}

export type HerdrConnection = 'connecting' | 'connected' | 'disconnected'

export interface PromptOption {
  n: number
  label: string
  description: string | null
  approving: boolean
}

export type RecognizedPrompt =
  | { kind: 'permission'; tool: string; request: string; question: string; options: PromptOption[] }
  | {
      kind: 'choice'
      header: string | null
      question: string
      options: PromptOption[]
      freeTextOption: number | null
    }
  | { kind: 'idle' }
  | { kind: 'unrecognized' }
  | { kind: 'none' }

export type Prompt =
  (Exclude<RecognizedPrompt, { kind: 'none' }> & { fingerprint: string }) | { kind: 'none' }

export const REPLY_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'enter', 'esc'] as const

export type ReplyKey = (typeof REPLY_KEYS)[number]

export type ReplyAction =
  | { type: 'option'; n: number }
  | { type: 'freeText'; text: string }
  | { type: 'prompt'; text: string }
  | { type: 'keys'; keys: ReplyKey[] }
  | { type: 'text'; text: string }

export interface ReplyRequest {
  replyId: string
  fingerprint: string
  action: ReplyAction
}
