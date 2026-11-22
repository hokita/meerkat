import { afterEach, describe, expect, it } from 'vitest'
import { fakeSnapshot, startFakeHerdr, type FakeHerdr } from '../../test-support/fake-herdr.js'
import { createHerdrClient } from './herdr/client.js'
import { readScreen } from './read-screen.js'

const RECENT = {
  target: 'w1:p1',
  source: 'recent_unwrapped',
  lines: 120,
  format: 'text',
  strip_ansi: true,
}
const VISIBLE = { target: 'w1:p1', source: 'visible', format: 'text', strip_ansi: true }

describe('readScreen', () => {
  const fakes: FakeHerdr[] = []

  afterEach(async () => {
    for (const fake of fakes.splice(0)) await fake.stop()
  })

  async function startFake(reads: Record<string, string> = {}) {
    const fake = await startFakeHerdr({ snapshot: fakeSnapshot({ agents: [] }), reads })
    fakes.push(fake)
    return { fake, client: createHerdrClient({ socketPath: fake.socketPath }) }
  }

  function readParams(fake: FakeHerdr): unknown[] {
    return fake.received.filter((r) => r.method === 'agent.read').map((r) => r.params)
  }

  it('reads 120 recent lines from an idle pane', async () => {
    const { fake, client } = await startFake({ 'w1:p1': 'hello' })
    expect(await readScreen(client, 'w1:p1')).toEqual({
      kind: 'ok',
      text: 'hello',
      truncated: false,
      source: 'recent_unwrapped',
    })
    expect(readParams(fake)).toEqual([RECENT])
  })

  it('falls back to the visible screen on a busy pane shorter than 120 rows', async () => {
    const { fake, client } = await startFake({ 'w1:p1': 'hello' })
    fake.setBusyViewport('w1:p1', 28)
    expect(await readScreen(client, 'w1:p1')).toMatchObject({
      kind: 'ok',
      text: 'hello',
      source: 'visible',
    })
    expect(readParams(fake)).toEqual([RECENT, VISIBLE])
  })

  it('does not retry when the pane is tall enough', async () => {
    const { fake, client } = await startFake({ 'w1:p1': 'hello' })
    fake.setBusyViewport('w1:p1', 120)
    expect(await readScreen(client, 'w1:p1')).toMatchObject({ source: 'recent_unwrapped' })
    expect(readParams(fake)).toEqual([RECENT])
  })

  it('returns gone for a closed pane', async () => {
    const { fake, client } = await startFake()
    expect(await readScreen(client, 'w1:p1')).toEqual({ kind: 'gone' })
    expect(readParams(fake)).toEqual([RECENT])
  })
})
