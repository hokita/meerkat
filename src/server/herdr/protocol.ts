import type { AgentStatus } from '../../shared/types.js'

export interface HerdrAgent {
  paneId: string
  workspaceId: string
  name: string | null
  status: AgentStatus
  cwd: string | null
  terminalTitle: string | null
}

export interface HerdrWorkspace {
  workspaceId: string
  label: string
  repoName: string | null
}

export interface HerdrSnapshot {
  protocol: number
  agents: HerdrAgent[]
  workspaces: HerdrWorkspace[]
  paneIds: string[]
}

export class HerdrProtocolError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'HerdrProtocolError'
    this.code = code
  }
}

export type StreamItem =
  | { kind: 'started' }
  | { kind: 'status'; paneId: string; workspaceId: string; status: AgentStatus }
  | { kind: 'topology' }
  | { kind: 'error'; code: string; message: string }
  | { kind: 'malformed' }

export type ReadResult = { kind: 'ok'; text: string; truncated: boolean } | { kind: 'gone' }

type JsonObject = Record<string, unknown>

const STATUSES: readonly AgentStatus[] = ['idle', 'working', 'blocked', 'done', 'unknown']

const LIFECYCLE_SUBSCRIPTIONS = [
  'pane.created',
  'pane.closed',
  'pane.updated',
  'pane.exited',
  'pane.agent_detected',
  'workspace.created',
  'workspace.renamed',
  'workspace.closed',
]

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    throw malformed('not valid JSON')
  }
}

function malformed(detail: string): HerdrProtocolError {
  return new HerdrProtocolError('malformed', `Malformed Herdr response: ${detail}`)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function requireString(source: JsonObject, key: string): string {
  const value = source[key]
  if (typeof value !== 'string') throw malformed(`missing string field ${key}`)
  return value
}

function parseStatus(value: unknown): AgentStatus {
  return STATUSES.find((status) => status === value) ?? 'unknown'
}

function errorOf(envelope: JsonObject): { code: string; message: string } | null {
  const error = envelope['error']
  if (!isObject(error)) return null
  return { code: asString(error['code']) ?? 'malformed', message: asString(error['message']) ?? '' }
}

function resultOf(line: string, type: string): JsonObject {
  const envelope = parseJson(line)
  if (!isObject(envelope)) throw malformed('not an object')
  const error = errorOf(envelope)
  if (error) throw new HerdrProtocolError(error.code, error.message)
  const result = envelope['result']
  if (!isObject(result) || result['type'] !== type) throw malformed(`expected ${type} result`)
  return result
}

function objectArray(source: JsonObject, key: string): JsonObject[] {
  const value = source[key]
  if (!Array.isArray(value)) throw malformed(`missing array field ${key}`)
  return value.map((item) => {
    if (!isObject(item)) throw malformed(`non-object entry in ${key}`)
    return item
  })
}

export function parseSnapshotResponse(line: string): HerdrSnapshot {
  const result = resultOf(line, 'session_snapshot')
  const snapshot = result['snapshot']
  if (!isObject(snapshot)) throw malformed('missing snapshot')
  const protocol = snapshot['protocol']
  if (typeof protocol !== 'number') throw malformed('missing protocol')

  const agents = objectArray(snapshot, 'agents').map((agent): HerdrAgent => {
    return {
      paneId: requireString(agent, 'pane_id'),
      workspaceId: requireString(agent, 'workspace_id'),
      name: asString(agent['name']),
      status: parseStatus(agent['agent_status']),
      cwd: asString(agent['cwd']),
      terminalTitle:
        asString(agent['terminal_title_stripped']) ?? asString(agent['terminal_title']),
    }
  })

  const workspaces = objectArray(snapshot, 'workspaces').map((workspace): HerdrWorkspace => {
    const worktree = workspace['worktree']
    return {
      workspaceId: requireString(workspace, 'workspace_id'),
      label: requireString(workspace, 'label'),
      repoName: isObject(worktree) ? asString(worktree['repo_name']) : null,
    }
  })

  const paneIds = objectArray(snapshot, 'panes').map((pane) => requireString(pane, 'pane_id'))

  return { protocol, agents, workspaces, paneIds }
}

export function parseStreamLine(line: string): StreamItem {
  let envelope: unknown
  try {
    envelope = JSON.parse(line)
  } catch {
    return { kind: 'malformed' }
  }
  if (!isObject(envelope)) return { kind: 'malformed' }

  const error = errorOf(envelope)
  if (error) return { kind: 'error', code: error.code, message: error.message }

  const result = envelope['result']
  if (isObject(result) && result['type'] === 'subscription_started') return { kind: 'started' }

  if (typeof envelope['event'] !== 'string') return { kind: 'malformed' }

  const data = envelope['data']
  if (envelope['event'] === 'pane.agent_status_changed' && isObject(data)) {
    const paneId = asString(data['pane_id'])
    const workspaceId = asString(data['workspace_id'])
    if (paneId === null || workspaceId === null) return { kind: 'malformed' }
    return { kind: 'status', paneId, workspaceId, status: parseStatus(data['agent_status']) }
  }
  return { kind: 'topology' }
}

export function parseReadResponse(line: string): ReadResult {
  let result: JsonObject
  try {
    result = resultOf(line, 'pane_read')
  } catch (error) {
    if (error instanceof HerdrProtocolError && error.code === 'agent_not_found') {
      return { kind: 'gone' }
    }
    throw error
  }
  const read = result['read']
  if (!isObject(read)) throw malformed('missing read')
  return {
    kind: 'ok',
    text: requireString(read, 'text'),
    truncated: read['truncated'] === true,
  }
}

export function subscribeParams(paneIds: string[]): { subscriptions: object[] } {
  return {
    subscriptions: [
      ...LIFECYCLE_SUBSCRIPTIONS.map((type) => ({ type })),
      ...paneIds.map((paneId) => ({ type: 'pane.agent_status_changed', pane_id: paneId })),
    ],
  }
}
