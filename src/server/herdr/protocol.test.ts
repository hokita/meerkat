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
    expect(snapshot.paneIds).toEqual(['w1H:p1', 'wE:p1'])
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
