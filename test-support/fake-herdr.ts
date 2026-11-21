import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LineSplitter } from '../src/server/herdr/lines.js'

const MAX_SOCKET_PATH_BYTES = 100

export interface ReceivedRequest {
  method: string
  params: unknown
}

export interface FakeHerdr {
  socketPath: string
  received: ReceivedRequest[]
  connectionCount: number
  setSnapshot(snapshot: unknown): void
  setRead(paneId: string, text: string | null): void
  pushStatus(paneId: string, status: string, workspaceId?: string): void
  pushRaw(line: string): void
  stop(): Promise<void>
  restart(): Promise<void>
}

export interface FakeHerdrOptions {
  snapshot: unknown
  reads?: Record<string, string>
}

export interface FakeAgent {
  pane_id: string
  workspace_id: string
  tab_id: string
  terminal_id: string
  name: string | null
  agent: string
  agent_status: string
  cwd: string
  foreground_cwd: string
  terminal_title: string
  terminal_title_stripped: string
  focused: boolean
  revision: number
  state_change_seq: number
  completion_seq: number
}

export interface FakeWorkspace {
  workspace_id: string
  number: number
  label: string
  focused: boolean
  pane_count: number
  tab_count: number
  active_tab_id: string
  agent_status: string
  worktree: {
    repo_name: string
    checkout_path: string
    is_linked_worktree: boolean
    repo_root: string
    repo_key: string
  }
}

let agentCounter = 0
let workspaceCounter = 0

export function fakeAgent(partial: Partial<FakeAgent> = {}): FakeAgent {
  agentCounter += 1
  const paneId = partial.pane_id ?? `w${agentCounter}:p1`
  const workspaceId = partial.workspace_id ?? paneId.split(':')[0] ?? `w${agentCounter}`
  const cwd = partial.cwd ?? `/Users/u/ghq/github.com/hokita/repo${agentCounter}`
  return {
    pane_id: paneId,
    workspace_id: workspaceId,
    tab_id: `${workspaceId}:t1`,
    terminal_id: `term-${agentCounter}`,
    name: null,
    agent: 'claude',
    agent_status: 'idle',
    cwd,
    foreground_cwd: cwd,
    terminal_title: '',
    terminal_title_stripped: '',
    focused: false,
    revision: 0,
    state_change_seq: 0,
    completion_seq: 0,
    ...partial,
  }
}

export function fakeWorkspace(partial: Partial<FakeWorkspace> = {}): FakeWorkspace {
  workspaceCounter += 1
  const workspaceId = partial.workspace_id ?? `w${workspaceCounter}`
  const repoName = partial.worktree?.repo_name ?? `repo${workspaceCounter}`
  const path = `/Users/u/ghq/github.com/hokita/${repoName}`
  return {
    workspace_id: workspaceId,
    number: workspaceCounter,
    label: repoName,
    focused: false,
    pane_count: 1,
    tab_count: 1,
    active_tab_id: `${workspaceId}:t1`,
    agent_status: 'unknown',
    worktree: {
      repo_name: repoName,
      checkout_path: path,
      is_linked_worktree: false,
      repo_root: path,
      repo_key: path,
    },
    ...partial,
  }
}

export function fakeSnapshot(opts: {
  agents: FakeAgent[]
  workspaces?: Partial<FakeWorkspace>[]
}): unknown {
  return {
    version: '0.9.5',
    protocol: 22,
    workspaces: (opts.workspaces ?? []).map((workspace) => fakeWorkspace(workspace)),
    tabs: [],
    panes: opts.agents.map((agent) => ({
      pane_id: agent.pane_id,
      workspace_id: agent.workspace_id,
      tab_id: agent.tab_id,
      terminal_id: agent.terminal_id,
      focused: agent.focused,
    })),
    layouts: [],
    agents: opts.agents,
    focused_workspace_id: null,
    focused_tab_id: null,
    focused_pane_id: null,
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function startFakeHerdr(options: FakeHerdrOptions): Promise<FakeHerdr> {
  let snapshot = options.snapshot
  const reads = new Map<string, string>(Object.entries(options.reads ?? {}))
  const connections = new Set<net.Socket>()
  const subscribers = new Set<net.Socket>()
  const dir = await mkdtemp(join(tmpdir(), 'mk-'))
  const socketPath = join(dir, 'h.sock')
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    await rm(dir, { recursive: true, force: true })
    throw new Error(`Fake Herdr socket path is too long for a Unix socket: ${socketPath}`)
  }
  let server: net.Server | null = null

  const fake: FakeHerdr = {
    socketPath,
    received: [],
    connectionCount: 0,
    setSnapshot(next) {
      snapshot = next
    },
    setRead(paneId, text) {
      if (text === null) reads.delete(paneId)
      else reads.set(paneId, text)
    },
    pushStatus(paneId, status, workspaceId) {
      const data = {
        agent: 'claude',
        agent_status: status,
        pane_id: paneId,
        workspace_id: workspaceId ?? paneId.split(':')[0],
      }
      fake.pushRaw(JSON.stringify({ data, event: 'pane.agent_status_changed' }))
    },
    pushRaw(line) {
      for (const socket of subscribers) socket.write(`${line}\n`)
    },
    async stop() {
      const closing = server
      server = null
      for (const socket of connections) socket.destroy()
      connections.clear()
      subscribers.clear()
      if (closing) await new Promise<void>((resolve) => closing.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    },
    async restart() {
      await fake.stop()
      await listen()
    },
  }

  function respond(socket: net.Socket, id: unknown, request: Record<string, unknown>): void {
    const method = request['method']
    const params = request['params']
    if (method === 'session.snapshot') {
      socket.end(`${JSON.stringify({ id, result: { type: 'session_snapshot', snapshot } })}\n`)
    } else if (method === 'agent.read') {
      const target = isObject(params) ? params['target'] : undefined
      const text = typeof target === 'string' ? reads.get(target) : undefined
      if (typeof target !== 'string' || text === undefined) {
        const error = {
          code: 'agent_not_found',
          message: `agent target ${String(target)} not found`,
        }
        socket.end(`${JSON.stringify({ id, error })}\n`)
        return
      }
      const read = {
        pane_id: target,
        workspace_id: target.split(':')[0],
        tab_id: `${target.split(':')[0]}:t1`,
        source: 'recent_unwrapped',
        format: 'text',
        text,
        revision: 0,
        truncated: false,
      }
      socket.end(`${JSON.stringify({ id, result: { type: 'pane_read', read } })}\n`)
    } else if (method === 'events.subscribe') {
      subscribers.add(socket)
      socket.write(`${JSON.stringify({ id, result: { type: 'subscription_started' } })}\n`)
    } else {
      const error = { code: 'invalid_request', message: `unsupported method ${String(method)}` }
      socket.end(`${JSON.stringify({ id, error })}\n`)
    }
  }

  function handleConnection(socket: net.Socket): void {
    fake.connectionCount += 1
    connections.add(socket)
    const splitter = new LineSplitter()
    socket.on('data', (chunk) => {
      for (const line of splitter.push(chunk)) {
        let request: unknown
        try {
          request = JSON.parse(line)
        } catch {
          socket.end(
            `${JSON.stringify({ error: { code: 'invalid_request', message: 'invalid JSON' } })}\n`
          )
          continue
        }
        if (!isObject(request) || typeof request['method'] !== 'string') continue
        fake.received.push({ method: request['method'], params: request['params'] })
        respond(socket, request['id'], request)
      }
    })
    socket.on('error', () => undefined)
    socket.on('close', () => {
      connections.delete(socket)
      subscribers.delete(socket)
    })
  }

  async function listen(): Promise<void> {
    await mkdir(dir, { recursive: true })
    const next = net.createServer(handleConnection)
    await new Promise<void>((resolve, reject) => {
      next.once('error', reject)
      next.listen(socketPath, () => resolve())
    })
    server = next
  }

  await listen()
  return fake
}
