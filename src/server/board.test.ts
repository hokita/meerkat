import { describe, expect, it } from 'vitest'
import type { AgentStatus } from '../shared/types.js'
import {
  applyProgress,
  applyReply,
  applyStatusEvent,
  boardFromSnapshot,
  columnOf,
  expireReplies,
  repoName,
  toView,
} from './board.js'
import type { HerdrAgent, HerdrSnapshot } from './herdr/protocol.js'

const HOME = '/Users/u'

function agent(paneId: string, status: AgentStatus, extra: Partial<HerdrAgent> = {}): HerdrAgent {
  return {
    paneId,
    workspaceId: 'w1',
    name: null,
    status,
    agent: 'claude',
    terminalId: `t-${paneId}`,
    cwd: '/Users/u/ghq/github.com/hokita/pigeon',
    terminalTitle: null,
    ...extra,
  }
}

function snapshot(agents: HerdrAgent[]): HerdrSnapshot {
  return {
    protocol: 1,
    agents,
    workspaces: [{ workspaceId: 'w1', label: 'one', repoName: null }],
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
      progress: null,
      agent: 'claude',
      terminalId: 't-p1',
      statusEpoch: 0,
      lastReply: null,
    })
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

  it('updates the title even when the status is unchanged', () => {
    const next = applyStatusEvent(state, { paneId: 'p1', status: 'working', title: 'New' }, 5000)
    expect(next).not.toBe(state)
    expect(next.cards.get('p1')).toMatchObject({
      status: 'working',
      title: 'New',
      since: 1000,
      sinceIsLowerBound: true,
    })
  })

  it('updates the title alongside a status change', () => {
    const next = applyStatusEvent(state, { paneId: 'p1', status: 'done', title: null }, 5000)
    expect(next.cards.get('p1')).toMatchObject({ status: 'done', title: null, since: 5000 })
  })

  it('returns the same state when the title is unchanged', () => {
    const titled = applyStatusEvent(state, { paneId: 'p1', status: 'working', title: 'T' }, 5000)
    expect(applyStatusEvent(titled, { paneId: 'p1', status: 'working', title: 'T' }, 6000)).toBe(
      titled
    )
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

describe('applyProgress', () => {
  const state = boardFromSnapshot(null, snapshot([agent('p1', 'working')]), 1000, HOME)

  it('new cards start with no progress', () => {
    expect(state.cards.get('p1')?.progress).toBeNull()
  })

  it('first progress is a lower bound', () => {
    const next = applyProgress(state, 'p1', 'hello', 2000)
    expect(next.cards.get('p1')?.progress).toEqual({
      text: 'hello',
      since: 2000,
      sinceIsLowerBound: true,
    })
  })

  it('same text keeps since and returns the same state object', () => {
    const first = applyProgress(state, 'p1', 'hello', 2000)
    const second = applyProgress(first, 'p1', 'hello', 9000)
    expect(second).toBe(first)
    expect(second.cards.get('p1')?.progress?.since).toBe(2000)
  })

  it('changed text resets since exactly', () => {
    const first = applyProgress(state, 'p1', 'hello', 2000)
    const second = applyProgress(first, 'p1', 'world', 5000)
    expect(second.cards.get('p1')?.progress).toEqual({
      text: 'world',
      since: 5000,
      sinceIsLowerBound: false,
    })
  })

  it('unknown pane is ignored', () => {
    expect(applyProgress(state, 'nope', 'hello', 2000)).toBe(state)
  })

  it('snapshot keeps progress of existing cards and drops removed ones', () => {
    const withProgress = applyProgress(
      applyProgress(state, 'p1', 'hello', 2000),
      'p1',
      'hello',
      2500
    )
    const both = boardFromSnapshot(
      withProgress,
      snapshot([agent('p1', 'working'), agent('p2', 'idle')]),
      3000,
      HOME
    )
    const expected = { text: 'hello', since: 2000, sinceIsLowerBound: true }
    expect(both.cards.get('p1')?.progress).toEqual(expected)
    const evented = applyStatusEvent(both, { paneId: 'p1', status: 'done' }, 4000)
    expect(evented.cards.get('p1')?.progress).toEqual(expected)
    const dropped = boardFromSnapshot(evented, snapshot([agent('p2', 'idle')]), 5000, HOME)
    expect([...dropped.cards.keys()]).toEqual(['p2'])
  })
})

describe('statusEpoch', () => {
  it('counts status changes from events and snapshots, not title changes', () => {
    let state = boardFromSnapshot(null, snapshot([agent('p1', 'working')]), 1000, HOME)
    expect(state.cards.get('p1')?.statusEpoch).toBe(0)
    state = applyStatusEvent(state, { paneId: 'p1', status: 'working', title: 'T' }, 1100)
    expect(state.cards.get('p1')?.statusEpoch).toBe(0)
    state = applyStatusEvent(state, { paneId: 'p1', status: 'blocked' }, 1200)
    expect(state.cards.get('p1')?.statusEpoch).toBe(1)
    state = boardFromSnapshot(state, snapshot([agent('p1', 'blocked')]), 1300, HOME)
    expect(state.cards.get('p1')?.statusEpoch).toBe(1)
    state = boardFromSnapshot(state, snapshot([agent('p1', 'idle')]), 1400, HOME)
    expect(state.cards.get('p1')?.statusEpoch).toBe(2)
  })

  it('gives new cards and re-added panes the next counter value', () => {
    const first = boardFromSnapshot(null, snapshot([agent('p1', 'idle')]), 1000, HOME)
    const added = boardFromSnapshot(
      first,
      snapshot([agent('p1', 'idle'), agent('p2', 'idle')]),
      1200,
      HOME
    )
    expect(first.cards.get('p1')?.statusEpoch).toBe(0)
    expect(added.cards.get('p1')?.statusEpoch).toBe(0)
    expect(added.cards.get('p2')?.statusEpoch).toBe(1)
    const removed = boardFromSnapshot(added, snapshot([agent('p2', 'idle')]), 1300, HOME)
    const back = boardFromSnapshot(
      removed,
      snapshot([agent('p1', 'idle'), agent('p2', 'idle')]),
      1400,
      HOME
    )
    expect(back.cards.get('p1')?.statusEpoch).toBe(2)
  })

  it('increases strictly across changes on different panes', () => {
    let state = boardFromSnapshot(
      null,
      snapshot([agent('p1', 'working'), agent('p2', 'working')]),
      1000,
      HOME
    )
    const seen: number[] = [...state.cards.values()].map((card) => card.statusEpoch)
    for (const [paneId, status] of [
      ['p1', 'idle'],
      ['p2', 'idle'],
      ['p1', 'working'],
    ] as const) {
      state = applyStatusEvent(state, { paneId, status }, 2000)
      seen.push(state.cards.get(paneId)?.statusEpoch ?? -1)
    }
    expect(seen).toEqual([0, 1, 2, 3, 4])
  })

  it('continues the counter when seeded from an earlier state after a gap', () => {
    const before = applyStatusEvent(
      boardFromSnapshot(null, snapshot([agent('p1', 'blocked')]), 1000, HOME),
      { paneId: 'p1', status: 'working' },
      1100
    )
    const seeded = { cards: new Map(), nextEpoch: before.nextEpoch }
    const after = boardFromSnapshot(seeded, snapshot([agent('p1', 'blocked')]), 1200, HOME)
    expect(before.cards.get('p1')?.statusEpoch).toBe(1)
    expect(after.cards.get('p1')?.statusEpoch).toBe(2)
  })
})

describe('replies', () => {
  const blocked = boardFromSnapshot(null, snapshot([agent('p1', 'blocked')]), 1000, HOME)

  it('applyReply records the summary, time and epoch', () => {
    const next = applyReply(blocked, 'p1', 'Yes', 2000)
    expect(next.cards.get('p1')?.lastReply).toEqual({ summary: 'Yes', at: 2000, epoch: 0 })
    expect(applyReply(blocked, 'nope', 'Yes', 2000)).toBe(blocked)
  })

  it('keeps the reply through working and snapshots', () => {
    let state = applyReply(blocked, 'p1', 'Yes', 2000)
    state = applyStatusEvent(state, { paneId: 'p1', status: 'working' }, 2100)
    expect(state.cards.get('p1')?.lastReply).not.toBeNull()
    state = boardFromSnapshot(state, snapshot([agent('p1', 'working')]), 2200, HOME)
    expect(state.cards.get('p1')?.lastReply).not.toBeNull()
  })

  it.each(['blocked', 'idle', 'done'] as const)('a later change into %s clears it', (status) => {
    let state = applyReply(blocked, 'p1', 'Yes', 2000)
    state = applyStatusEvent(state, { paneId: 'p1', status: 'working' }, 2100)
    state = applyStatusEvent(state, { paneId: 'p1', status }, 2200)
    expect(state.cards.get('p1')?.lastReply).toBeNull()
  })

  it('a snapshot showing a later reply-able status clears it', () => {
    const replied = applyReply(blocked, 'p1', 'Yes', 2000)
    const next = boardFromSnapshot(replied, snapshot([agent('p1', 'idle')]), 2200, HOME)
    expect(next.cards.get('p1')?.lastReply).toBeNull()
  })

  it('expireReplies drops replies after 600000 ms', () => {
    const replied = applyReply(blocked, 'p1', 'Yes', 2000)
    expect(expireReplies(replied, 2000 + 599_999)).toBe(replied)
    const expired = expireReplies(replied, 2000 + 600_000)
    expect(expired.cards.get('p1')?.lastReply).toBeNull()
  })
})
