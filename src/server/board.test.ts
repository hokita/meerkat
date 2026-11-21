import { describe, expect, it } from 'vitest'
import type { AgentStatus } from '../shared/types.js'
import { applyStatusEvent, boardFromSnapshot, columnOf, repoName, toView } from './board.js'
import type { HerdrAgent, HerdrSnapshot } from './herdr/protocol.js'

const HOME = '/Users/u'

function agent(paneId: string, status: AgentStatus, extra: Partial<HerdrAgent> = {}): HerdrAgent {
  return {
    paneId,
    workspaceId: 'w1',
    name: null,
    status,
    cwd: '/Users/u/ghq/github.com/hokita/pigeon',
    terminalTitle: null,
    ...extra,
  }
}

function snapshot(agents: HerdrAgent[], paneIds: string[] = []): HerdrSnapshot {
  return {
    protocol: 1,
    agents,
    workspaces: [{ workspaceId: 'w1', label: 'one', repoName: null }],
    paneIds: [...paneIds, ...agents.map((a) => a.paneId)],
  }
}

describe('columnOf', () => {
  it('maps statuses to columns', () => {
    expect(columnOf('done')).toBe('attention')
    expect(columnOf('blocked')).toBe('attention')
    expect(columnOf('working')).toBe('working')
    expect(columnOf('idle')).toBe('idle')
    expect(columnOf('unknown')).toBe('idle')
  })
})

describe('repoName', () => {
  it('prefers the workspace repo name', () => {
    const workspace = { workspaceId: 'w1', label: 'x', repoName: 'hamster' }
    expect(repoName('/anything', workspace, HOME)).toBe('hamster')
  })

  it('uses the worktree repo directory under the herdr worktrees root', () => {
    expect(repoName('/Users/u/.herdr/worktrees/meerkat/feat-initial-app', undefined, HOME)).toBe(
      'meerkat'
    )
  })

  it('uses the cwd basename otherwise', () => {
    expect(repoName('/Users/u/ghq/github.com/hokita/pigeon', undefined, HOME)).toBe('pigeon')
  })

  it('ignores trailing slashes', () => {
    expect(repoName('/Users/u/ghq/github.com/hokita/pigeon/', undefined, HOME)).toBe('pigeon')
  })

  it('does not apply the worktree rule outside the home worktrees root', () => {
    expect(repoName('/other/.herdr/worktrees/meerkat/branch', undefined, HOME)).toBe('branch')
  })

  it('returns (unknown) for a null cwd or an empty basename', () => {
    expect(repoName(null, undefined, HOME)).toBe('(unknown)')
    expect(repoName('/', undefined, HOME)).toBe('(unknown)')
  })
})

describe('boardFromSnapshot', () => {
  it('creates cards with a lower-bound since on the first snapshot', () => {
    const state = boardFromSnapshot(
      null,
      snapshot([agent('p1', 'working', { terminalTitle: 'Fix bug' })]),
      1000,
      HOME
    )
    expect(state.cards.get('p1')).toEqual({
      paneId: 'p1',
      workspaceId: 'w1',
      name: null,
      repo: 'pigeon',
      title: 'Fix bug',
      status: 'working',
      since: 1000,
      sinceIsLowerBound: true,
    })
  })

  it('only turns agents into cards', () => {
    const state = boardFromSnapshot(null, snapshot([agent('p1', 'idle')], ['bare']), 1000, HOME)
    expect([...state.cards.keys()]).toEqual(['p1'])
  })

  it('keeps since for unchanged statuses and refreshes other fields', () => {
    const first = boardFromSnapshot(null, snapshot([agent('p1', 'working')]), 1000, HOME)
    const event = applyStatusEvent(first, { paneId: 'p1', status: 'working' }, 1500)
    expect(event).toBe(first)
    const second = boardFromSnapshot(
      first,
      snapshot([agent('p1', 'working', { name: 'renamed', terminalTitle: 'T' })]),
      2000,
      HOME
    )
    expect(second.cards.get('p1')).toMatchObject({
      since: 1000,
      sinceIsLowerBound: true,
      name: 'renamed',
      title: 'T',
    })
  })

  it('keeps an exact since from an event when the status is unchanged', () => {
    const first = boardFromSnapshot(null, snapshot([agent('p1', 'working')]), 1000, HOME)
    const evented = applyStatusEvent(first, { paneId: 'p1', status: 'done' }, 3000)
    const second = boardFromSnapshot(evented, snapshot([agent('p1', 'done')]), 4000, HOME)
    expect(second.cards.get('p1')).toMatchObject({ since: 3000, sinceIsLowerBound: false })
  })

  it('removes panes that are gone', () => {
    const first = boardFromSnapshot(
      null,
      snapshot([agent('p1', 'idle'), agent('p2', 'idle')]),
      1000,
      HOME
    )
    const second = boardFromSnapshot(first, snapshot([agent('p2', 'idle')]), 2000, HOME)
    expect([...second.cards.keys()]).toEqual(['p2'])
  })

  it('resets since when the status changed', () => {
    const first = boardFromSnapshot(null, snapshot([agent('p1', 'working')]), 1000, HOME)
    const second = boardFromSnapshot(first, snapshot([agent('p1', 'done')]), 2000, HOME)
    expect(second.cards.get('p1')).toMatchObject({
      status: 'done',
      since: 2000,
      sinceIsLowerBound: true,
    })
  })
})

describe('applyStatusEvent', () => {
  const state = boardFromSnapshot(null, snapshot([agent('p1', 'working')]), 1000, HOME)

  it('sets an exact since on a status change', () => {
    const next = applyStatusEvent(state, { paneId: 'p1', status: 'done' }, 5000)
    expect(next.cards.get('p1')).toMatchObject({
      status: 'done',
      since: 5000,
      sinceIsLowerBound: false,
    })
    expect(state.cards.get('p1')?.status).toBe('working')
  })

  it('returns the same state for unknown panes and unchanged statuses', () => {
    expect(applyStatusEvent(state, { paneId: 'nope', status: 'done' }, 5000)).toBe(state)
    expect(applyStatusEvent(state, { paneId: 'p1', status: 'working' }, 5000)).toBe(state)
  })
})

describe('toView', () => {
  it('groups and orders cards', () => {
    const agents = [
      agent('a1', 'done'),
      agent('a2', 'blocked'),
      agent('w1', 'working'),
      agent('w2', 'working'),
      agent('i1', 'idle', { name: 'zed' }),
      agent('i2', 'unknown', { name: 'amy' }),
      agent('i4', 'idle'),
      agent('i3', 'idle'),
    ]
    let state = boardFromSnapshot(null, snapshot(agents), 1000, HOME)
    state = applyStatusEvent(state, { paneId: 'a1', status: 'blocked' }, 3000)
    state = applyStatusEvent(state, { paneId: 'a2', status: 'done' }, 2000)
    state = applyStatusEvent(state, { paneId: 'w1', status: 'idle' }, 4000)
    state = applyStatusEvent(state, { paneId: 'w1', status: 'working' }, 4500)
    state = applyStatusEvent(state, { paneId: 'w2', status: 'idle' }, 4600)
    state = applyStatusEvent(state, { paneId: 'w2', status: 'working' }, 4100)
    const view = toView(state)
    expect(view.attention.map((c) => c.paneId)).toEqual(['a2', 'a1'])
    expect(view.working.map((c) => c.paneId)).toEqual(['w2', 'w1'])
    expect(view.idle.map((c) => c.paneId)).toEqual(['i3', 'i4', 'i2', 'i1'])
  })
})
