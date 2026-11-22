import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeSnapshot, startFakeHerdr, type FakeHerdr } from '../../../test-support/fake-herdr.js'
import { MethodNotAllowedError } from './allowlist.js'
import { createHerdrClient, HerdrTimeoutError } from './client.js'
import { subscribeParams } from './protocol.js'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

async function fakeHerdr(
  opts: Parameters<typeof startFakeHerdr>[0] = { snapshot: fakeSnapshot({ agents: [] }) }
): Promise<FakeHerdr> {
  const fake = await startFakeHerdr(opts)
  cleanups.push(() => fake.stop())
  return fake
}

describe('request', () => {
  it('sends a snapshot request and resolves with the first line', async () => {
    const fake = await fakeHerdr()
    const client = createHerdrClient({ socketPath: fake.socketPath })
    const line = await client.request('session.snapshot', {})
    expect(line).toContain('session_snapshot')
    expect(fake.received).toEqual([{ method: 'session.snapshot', params: {} }])
    expect(fake.connectionCount).toBe(1)
  })

  it('uses a unique id per request', async () => {
    const fake = await fakeHerdr()
    const client = createHerdrClient({ socketPath: fake.socketPath })
    const first = JSON.parse(await client.request('session.snapshot', {})) as { id: string }
    const second = JSON.parse(await client.request('session.snapshot', {})) as { id: string }
    expect(first.id).toMatch(/^meerkat-\d+$/)
    expect(second.id).not.toBe(first.id)
  })

  it('reads a pane through agent.read', async () => {
    const fake = await fakeHerdr({
      snapshot: fakeSnapshot({ agents: [] }),
      reads: { 'w1:p1': 'hello' },
    })
    const client = createHerdrClient({ socketPath: fake.socketPath })
    expect(await client.request('agent.read', { target: 'w1:p1' })).toContain('hello')
    expect(await client.request('agent.read', { target: 'w1:p9' })).toContain('agent_not_found')
  })

  it.each(['agent.prompt', 'pane.close', 'server.stop'])(
    'rejects %s before opening any connection',
    async (method) => {
      const fake = await fakeHerdr()
      const client = createHerdrClient({ socketPath: fake.socketPath })
      await expect(client.request(method, {})).rejects.toBeInstanceOf(MethodNotAllowedError)
      expect(fake.connectionCount).toBe(0)
    }
  )

  it('rejects with ENOENT when the socket does not exist', async () => {
    const client = createHerdrClient({ socketPath: join(tmpdir(), 'mk-missing', 'h.sock') })
    await expect(client.request('session.snapshot', {})).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects with HerdrTimeoutError when the server never answers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mk-'))
    const socketPath = join(dir, 'h.sock')
    const sockets: net.Socket[] = []
    const server = net.createServer((socket) => sockets.push(socket))
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    cleanups.push(async () => {
      sockets.forEach((socket) => socket.destroy())
      await new Promise((resolve) => server.close(resolve))
      await rm(dir, { recursive: true, force: true })
    })
    const client = createHerdrClient({ socketPath, timeoutMs: 50 })
    await expect(client.request('session.snapshot', {})).rejects.toBeInstanceOf(HerdrTimeoutError)
  })
})

describe('subscribe', () => {
  it('subscribes once with one status entry per pane and relays pushed lines', async () => {
    const fake = await fakeHerdr()
    const client = createHerdrClient({ socketPath: fake.socketPath })
    const paneIds = Array.from({ length: 60 }, (_, index) => `w5:p${index + 1}`)
    const lines: string[] = []
    const subscription = client.subscribe(subscribeParams(paneIds), (line) => lines.push(line))
    cleanups.push(async () => subscription.close())

    await expect.poll(() => lines.length).toBe(1)
    expect(lines[0]).toContain('subscription_started')
    expect(fake.received).toHaveLength(1)
    const [request] = fake.received
    expect(request?.method).toBe('events.subscribe')
    const subscriptions = (request?.params as { subscriptions: { type: string }[] }).subscriptions
    expect(subscriptions.filter((s) => s.type === 'pane.agent_status_changed')).toHaveLength(60)

    fake.pushStatus('w5:p1', 'done')
    await expect.poll(() => lines.length).toBe(2)
    expect(lines[1]).toContain('"agent_status":"done"')
  })

  it('resolves ended without rejecting when the server goes away', async () => {
    const fake = await fakeHerdr()
    const client = createHerdrClient({ socketPath: fake.socketPath })
    const lines: string[] = []
    const subscription = client.subscribe(subscribeParams(['w1:p1']), (line) => lines.push(line))
    await expect.poll(() => lines.length).toBe(1)
    await fake.stop()
    const ended = await subscription.ended
    expect(ended === null || ended instanceof Error).toBe(true)
  })

  it('ends without an error when closed', async () => {
    const fake = await fakeHerdr()
    const client = createHerdrClient({ socketPath: fake.socketPath })
    const lines: string[] = []
    const subscription = client.subscribe(subscribeParams(['w1:p1']), (line) => lines.push(line))
    await expect.poll(() => lines.length).toBe(1)
    subscription.close()
    expect(await subscription.ended).toBeNull()
  })
})
