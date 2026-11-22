import { afterEach, describe, expect, it } from 'vitest'
import { fakeSnapshot, startFakeHerdr, type FakeHerdr } from '../../../test-support/fake-herdr.js'
import { HerdrProtocolError } from './protocol.js'
import type { ReplyKey } from '../../shared/types.js'
import { createReplySender } from './reply-sender.js'

let fake: FakeHerdr | null = null

async function start(): Promise<FakeHerdr> {
  fake = await startFakeHerdr({ snapshot: fakeSnapshot({ agents: [] }) })
  return fake
}

afterEach(async () => {
  await fake?.stop()
  fake = null
})

describe('createReplySender', () => {
  it('prompt sends agent.prompt without wait', async () => {
    const herdr = await start()
    await createReplySender({ socketPath: herdr.socketPath }).prompt('w1:p1', 'hello')
    expect(herdr.received).toEqual([
      { method: 'agent.prompt', params: { target: 'w1:p1', text: 'hello' } },
    ])
  })

  it('sendKeys sends agent.send_keys', async () => {
    const herdr = await start()
    await createReplySender({ socketPath: herdr.socketPath }).sendKeys('w1:p1', ['1', 'enter'])
    expect(herdr.received).toEqual([
      { method: 'agent.send_keys', params: { target: 'w1:p1', keys: ['1', 'enter'] } },
    ])
  })

  it('sendText sends pane.send_text', async () => {
    const herdr = await start()
    await createReplySender({ socketPath: herdr.socketPath }).sendText('w1:p1', 'Medium')
    expect(herdr.received).toEqual([
      { method: 'pane.send_text', params: { pane_id: 'w1:p1', text: 'Medium' } },
    ])
  })

  it('rejects a key outside the closed list before connecting', async () => {
    const herdr = await start()
    const sender = createReplySender({ socketPath: herdr.socketPath })
    const bad = ['ctrl+c'] as unknown as ReplyKey[]
    await expect(sender.sendKeys('w1:p1', bad)).rejects.toThrow()
    expect(herdr.connectionCount).toBe(0)
    expect(herdr.received).toEqual([])
  })

  it('rejects with the Herdr error code', async () => {
    const herdr = await start()
    herdr.setReplyError({ code: 'agent_blocked', message: 'agent is blocked' })
    const sender = createReplySender({ socketPath: herdr.socketPath })
    const failure = await sender.prompt('w1:p1', 'hi').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(HerdrProtocolError)
    expect((failure as HerdrProtocolError).code).toBe('agent_blocked')
  })
})
