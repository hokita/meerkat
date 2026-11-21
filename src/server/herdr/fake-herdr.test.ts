import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  fakeAgent,
  fakeSnapshot,
  startFakeHerdr,
  type FakeHerdr,
} from '../../../test-support/fake-herdr.js'
import { createHerdrClient } from './client.js'
import {
  parseReadResponse,
  parseSnapshotResponse,
  parseStreamLine,
  subscribeParams,
} from './protocol.js'

const fakes: FakeHerdr[] = []

afterEach(async () => {
  while (fakes.length > 0) await fakes.pop()?.stop()
})

async function start(opts: Parameters<typeof startFakeHerdr>[0]): Promise<FakeHerdr> {
  const fake = await startFakeHerdr(opts)
  fakes.push(fake)
  return fake
}

describe('builders', () => {
  it('fills agent defaults and unique terminal ids', () => {
    const first = fakeAgent({ pane_id: 'w7:p2' })
    const second = fakeAgent()
    expect(first).toMatchObject({
      agent: 'claude',
      agent_status: 'idle',
      name: null,
      workspace_id: 'w7',
      tab_id: 'w7:t1',
      focused: false,
      revision: 0,
    })
    expect(first.cwd.startsWith('/Users/u/ghq/github.com/hokita/')).toBe(true)
    expect(first.terminal_id).not.toBe(second.terminal_id)
  })

  it('produces a snapshot the protocol parser accepts', () => {
    const agents = [fakeAgent({ pane_id: 'w1:p1', name: 'a', agent_status: 'working' })]
    const line = JSON.stringify({
      id: 'x',
      result: {
        type: 'session_snapshot',
        snapshot: fakeSnapshot({ agents, workspaces: [{ workspace_id: 'w1' }] }),
      },
    })
    const parsed = parseSnapshotResponse(line)
    expect(parsed.protocol).toBe(22)
    expect(parsed.paneIds).toEqual(['w1:p1'])
    expect(parsed.agents[0]).toMatchObject({ paneId: 'w1:p1', name: 'a', status: 'working' })
    expect(parsed.workspaces).toHaveLength(1)
  })
})

describe('server', () => {
  it('serves updated snapshots and reads', async () => {
    const fake = await start({ snapshot: fakeSnapshot({ agents: [] }) })
    const client = createHerdrClient({ socketPath: fake.socketPath })
    fake.setSnapshot(fakeSnapshot({ agents: [fakeAgent({ pane_id: 'w2:p1' })] }))
    expect(parseSnapshotResponse(await client.request('session.snapshot', {})).paneIds).toEqual([
      'w2:p1',
    ])
    fake.setRead('w2:p1', 'hi')
    expect(parseReadResponse(await client.request('agent.read', { target: 'w2:p1' }))).toEqual({
      kind: 'ok',
      text: 'hi',
      truncated: false,
    })
    fake.setRead('w2:p1', null)
    expect(parseReadResponse(await client.request('agent.read', { target: 'w2:p1' }))).toEqual({
      kind: 'gone',
    })
  })

  it('pushes raw lines and status events to subscribers', async () => {
    const fake = await start({ snapshot: fakeSnapshot({ agents: [] }) })
    const client = createHerdrClient({ socketPath: fake.socketPath })
    const lines: string[] = []
    const subscription = client.subscribe(subscribeParams(['w1:p1']), (line) => lines.push(line))
    await expect.poll(() => lines.length).toBe(1)
    fake.pushStatus('w1:p1', 'blocked')
    fake.pushRaw('{"event":"pane_created","data":{}}')
    await expect.poll(() => lines.length).toBe(3)
    expect(parseStreamLine(lines[1] ?? '')).toEqual({
      kind: 'status',
      paneId: 'w1:p1',
      workspaceId: 'w1',
      status: 'blocked',
    })
    expect(parseStreamLine(lines[2] ?? '')).toEqual({ kind: 'topology' })
    subscription.close()
  })

  it('removes the socket on stop and listens again on the same path on restart', async () => {
    const fake = await start({ snapshot: fakeSnapshot({ agents: [] }) })
    const { socketPath } = fake
    await fake.stop()
    expect(existsSync(socketPath)).toBe(false)
    await fake.restart()
    expect(fake.socketPath).toBe(socketPath)
    const client = createHerdrClient({ socketPath })
    expect(await client.request('session.snapshot', {})).toContain('session_snapshot')
  })
})
