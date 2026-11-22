import { describe, expect, it } from 'vitest'
import {
  HerdrProtocolError,
  parseReadResponse,
  parseSnapshotResponse,
  parseStreamLine,
  subscribeParams,
} from './protocol.js'

function snapshotLine(overrides: { title?: string | null; worktree?: unknown } = {}): string {
  return JSON.stringify({
    id: 'm1',
    result: {
      type: 'session_snapshot',
      snapshot: {
        version: '0.9.5',
        protocol: 22,
        workspaces: [
          {
            workspace_id: 'wE',
            number: 1,
            label: 'hamster',
            focused: false,
            pane_count: 2,
            tab_count: 1,
            active_tab_id: 'wE:t1',
            agent_status: 'unknown',
            worktree:
              overrides.worktree === undefined
                ? {
                    repo_name: 'hamster',
                    checkout_path: '/x',
                    is_linked_worktree: false,
                    repo_root: '/x',
                    repo_key: 'k',
                  }
                : overrides.worktree,
          },
        ],
        tabs: [],
        panes: [{ pane_id: 'w1H:p1' }, { pane_id: 'wE:p1' }],
        layouts: [],
        agents: [
          {
            pane_id: 'w1H:p1',
            workspace_id: 'w1H',
            tab_id: 'w1H:t1',
            terminal_id: 't',
            name: 'meerkat-design',
            agent: 'claude',
            agent_status: 'working',
            cwd: '/Users/hokita/.herdr/worktrees/meerkat/feat-initial-app',
            foreground_cwd: '/y',
            terminal_title: 'raw title',
            terminal_title_stripped:
              overrides.title === undefined
                ? 'Meerkat design doc and implementation pl...'
                : overrides.title,
            focused: false,
            revision: 0,
            state_change_seq: 0,
            completion_seq: 217,
          },
        ],
        focused_workspace_id: 'wJ',
      },
    },
  })
}

describe('parseSnapshotResponse', () => {
  it('parses agents, workspaces and pane ids', () => {
    const snapshot = parseSnapshotResponse(snapshotLine())
    expect(snapshot.protocol).toBe(22)
    expect(snapshot.agents).toEqual([
      {
        paneId: 'w1H:p1',
        workspaceId: 'w1H',
        name: 'meerkat-design',
        status: 'working',
        cwd: '/Users/hokita/.herdr/worktrees/meerkat/feat-initial-app',
        terminalTitle: 'Meerkat design doc and implementation pl...',
      },
    ])
    expect(snapshot.workspaces).toEqual([
      { workspaceId: 'wE', label: 'hamster', repoName: 'hamster' },
    ])
    expect(snapshot).not.toHaveProperty('paneIds')
  })

  function tweak(edit: (snapshot: Record<string, unknown>) => void): string {
    const envelope = JSON.parse(snapshotLine()) as {
      result: { snapshot: Record<string, unknown> }
    }
    edit(envelope.result.snapshot)
    return JSON.stringify(envelope)
  }

  it('accepts a snapshot without protocol', () => {
    const line = tweak((snapshot) => {
      delete snapshot['protocol']
    })
    const parsed = parseSnapshotResponse(line)
    expect(parsed.protocol).toBeNull()
    expect(parsed.agents).toHaveLength(1)
  })

  it('accepts a workspace without a label', () => {
    const line = tweak((snapshot) => {
      const [workspace] = snapshot['workspaces'] as Record<string, unknown>[]
      if (workspace) delete workspace['label']
    })
    expect(parseSnapshotResponse(line).workspaces).toEqual([
      { workspaceId: 'wE', label: null, repoName: 'hamster' },
    ])
  })

  it('accepts a snapshot without panes', () => {
    const line = tweak((snapshot) => {
      delete snapshot['panes']
    })
    expect(parseSnapshotResponse(line).agents).toHaveLength(1)
  })

  it('skips a malformed agent and keeps the others', () => {
    const line = tweak((snapshot) => {
      const agents = snapshot['agents'] as Record<string, unknown>[]
      const [good] = agents
      snapshot['agents'] = [
        { ...good, pane_id: 'wX:p1', workspace_id: undefined },
        'not an object',
        good,
      ]
    })
    expect(parseSnapshotResponse(line).agents.map((agent) => agent.paneId)).toEqual(['w1H:p1'])
  })

  it('skips a malformed workspace and keeps the others', () => {
    const line = tweak((snapshot) => {
      const workspaces = snapshot['workspaces'] as Record<string, unknown>[]
      snapshot['workspaces'] = [{ label: 'no id' }, 7, ...workspaces]
    })
    expect(parseSnapshotResponse(line).workspaces.map((w) => w.workspaceId)).toEqual(['wE'])
  })

  it('treats missing workspaces as none', () => {
    const line = tweak((snapshot) => {
      delete snapshot['workspaces']
    })
    expect(parseSnapshotResponse(line).workspaces).toEqual([])
  })

  it('throws malformed when the agents array is missing', () => {
    const line = tweak((snapshot) => {
      delete snapshot['agents']
    })
    try {
      parseSnapshotResponse(line)
      expect.unreachable()
    } catch (error) {
      expect((error as HerdrProtocolError).code).toBe('malformed')
    }
  })

  it('falls back to terminal_title when the stripped title is null', () => {
    expect(parseSnapshotResponse(snapshotLine({ title: null })).agents[0]?.terminalTitle).toBe(
      'raw title'
    )
  })

  it('gives a null repoName when the worktree is null', () => {
    expect(
      parseSnapshotResponse(snapshotLine({ worktree: null })).workspaces[0]?.repoName
    ).toBeNull()
  })

  it('maps an unrecognised status to unknown', () => {
    const line = snapshotLine().replace('"agent_status":"working"', '"agent_status":"sleeping"')
    expect(parseSnapshotResponse(line).agents[0]?.status).toBe('unknown')
  })

  it('throws the Herdr error code for an error envelope', () => {
    const line = JSON.stringify({ id: 'm1', error: { code: 'x', message: 'y' } })
    expect(() => parseSnapshotResponse(line)).toThrow(HerdrProtocolError)
    try {
      parseSnapshotResponse(line)
    } catch (error) {
      expect((error as HerdrProtocolError).code).toBe('x')
    }
  })

  it('throws malformed for non-JSON', () => {
    try {
      parseSnapshotResponse('not json')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(HerdrProtocolError)
      expect((error as HerdrProtocolError).code).toBe('malformed')
    }
  })

  it('throws malformed for the wrong shape', () => {
    try {
      parseSnapshotResponse('{"id":"m1","result":{"type":"other"}}')
      expect.unreachable()
    } catch (error) {
      expect((error as HerdrProtocolError).code).toBe('malformed')
    }
  })
})

describe('parseStreamLine', () => {
  it('recognises subscription_started', () => {
    expect(parseStreamLine('{"id":"m","result":{"type":"subscription_started"}}')).toEqual({
      kind: 'started',
    })
  })

  it('parses a status change', () => {
    const line =
      '{"data":{"agent":"claude","agent_status":"blocked","pane_id":"wJ:p1","workspace_id":"wJ"},"event":"pane.agent_status_changed"}'
    expect(parseStreamLine(line)).toEqual({
      kind: 'status',
      paneId: 'wJ:p1',
      workspaceId: 'wJ',
      status: 'blocked',
    })
  })

  it('carries the title when the event has one', () => {
    const line =
      '{"data":{"agent_status":"working","pane_id":"wJ:p1","workspace_id":"wJ","title":"Fix bug"},"event":"pane.agent_status_changed"}'
    expect(parseStreamLine(line)).toEqual({
      kind: 'status',
      paneId: 'wJ:p1',
      workspaceId: 'wJ',
      status: 'working',
      title: 'Fix bug',
    })
  })

  it('carries a null title and ignores a non-string title', () => {
    const base = '"agent_status":"working","pane_id":"wJ:p1","workspace_id":"wJ"'
    const nullTitle = `{"data":{${base},"title":null},"event":"pane.agent_status_changed"}`
    const numberTitle = `{"data":{${base},"title":3},"event":"pane.agent_status_changed"}`
    expect(parseStreamLine(nullTitle)).toMatchObject({ kind: 'status', title: null })
    expect(parseStreamLine(numberTitle)).not.toHaveProperty('title')
  })

  it('maps an unrecognised status to unknown', () => {
    const line =
      '{"data":{"agent_status":"sleeping","pane_id":"wJ:p1","workspace_id":"wJ"},"event":"pane.agent_status_changed"}'
    expect(parseStreamLine(line)).toMatchObject({ kind: 'status', status: 'unknown' })
  })

  it.each([
    '{"event":"pane_created","data":{"type":"pane_created"}}',
    '{"event":"pane.closed","data":{}}',
  ])('treats %s as topology', (line) => {
    expect(parseStreamLine(line)).toEqual({ kind: 'topology' })
  })

  it('parses an error envelope', () => {
    expect(
      parseStreamLine('{"id":"m","error":{"code":"invalid_request","message":"bad"}}')
    ).toEqual({ kind: 'error', code: 'invalid_request', message: 'bad' })
  })

  it('treats non-JSON as malformed', () => {
    expect(parseStreamLine('not json')).toEqual({ kind: 'malformed' })
  })

  it('treats JSON without an event field as malformed', () => {
    expect(parseStreamLine('{"foo":1}')).toEqual({ kind: 'malformed' })
  })
})

describe('parseReadResponse', () => {
  it('parses a pane_read', () => {
    const line = JSON.stringify({
      id: 'm4',
      result: {
        type: 'pane_read',
        read: {
          pane_id: 'w1H:p1',
          workspace_id: 'w1H',
          tab_id: 'w1H:t1',
          source: 'recent_unwrapped',
          format: 'text',
          text: 'hello\nworld',
          revision: 0,
          truncated: true,
        },
      },
    })
    expect(parseReadResponse(line)).toEqual({ kind: 'ok', text: 'hello\nworld', truncated: true })
  })

  it('returns gone for agent_not_found', () => {
    const line = JSON.stringify({ id: 'm4', error: { code: 'agent_not_found', message: 'no' } })
    expect(parseReadResponse(line)).toEqual({ kind: 'gone' })
  })

  it('throws for any other error', () => {
    const line = JSON.stringify({ id: 'm4', error: { code: 'boom', message: 'no' } })
    expect(() => parseReadResponse(line)).toThrow(HerdrProtocolError)
  })
})

describe('subscribeParams', () => {
  it('lists each lifecycle subscription once and one status subscription per pane', () => {
    const { subscriptions } = subscribeParams(['w1:p1', 'w2:p1'])
    const lifecycle = [
      'pane.created',
      'pane.closed',
      'pane.updated',
      'pane.exited',
      'pane.agent_detected',
      'workspace.created',
      'workspace.renamed',
      'workspace.closed',
    ]
    for (const type of lifecycle) {
      expect(
        subscriptions.filter((s) => JSON.stringify(s) === JSON.stringify({ type }))
      ).toHaveLength(1)
    }
    expect(subscriptions).toContainEqual({ type: 'pane.agent_status_changed', pane_id: 'w1:p1' })
    expect(subscriptions).toContainEqual({ type: 'pane.agent_status_changed', pane_id: 'w2:p1' })
    expect(subscriptions).toHaveLength(lifecycle.length + 2)
  })
})
