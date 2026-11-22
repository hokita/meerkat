import type { HerdrClient } from './herdr/client.js'
import { HerdrProtocolError, parseReadResponse } from './herdr/protocol.js'

export const RECENT_LINES = 120

export type ScreenSource = 'recent_unwrapped' | 'visible'

export type ScreenRead =
  { kind: 'gone' } | { kind: 'ok'; text: string; truncated: boolean; source: ScreenSource }

async function readFrom(
  client: HerdrClient,
  target: string,
  source: ScreenSource
): Promise<ScreenRead> {
  const params = { target, source, format: 'text', strip_ansi: true }
  const read = parseReadResponse(
    await client.request(
      'agent.read',
      source === 'visible' ? params : { ...params, lines: RECENT_LINES }
    )
  )
  return read.kind === 'gone' ? read : { ...read, source }
}

export async function readScreen(client: HerdrClient, target: string): Promise<ScreenRead> {
  try {
    return await readFrom(client, target, 'recent_unwrapped')
  } catch (error) {
    if (error instanceof HerdrProtocolError && error.code === 'agent_not_idle') {
      return readFrom(client, target, 'visible')
    }
    throw error
  }
}
