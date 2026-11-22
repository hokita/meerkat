import { REPLY_KEYS, type ReplyKey } from '../../shared/types.js'
import { assertReplyAllowed } from './allowlist.js'
import { requestLine } from './client.js'
import { HerdrProtocolError, parseReplyResult } from './protocol.js'

export interface ReplySender {
  prompt(paneId: string, text: string): Promise<void>
  sendKeys(paneId: string, keys: readonly ReplyKey[]): Promise<void>
  sendText(paneId: string, text: string): Promise<void>
}

export interface ReplySenderOptions {
  socketPath: string
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 5000

function isReplyKey(key: string): key is ReplyKey {
  return REPLY_KEYS.some((allowed) => allowed === key)
}

export function createReplySender(opts: ReplySenderOptions): ReplySender {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let counter = 0

  async function send(method: string, params: object, resultType: string): Promise<void> {
    assertReplyAllowed(method)
    counter += 1
    const payload = `${JSON.stringify({ id: `meerkat-reply-${counter}`, method, params })}\n`
    parseReplyResult(await requestLine(opts.socketPath, payload, timeoutMs), resultType)
  }

  return {
    prompt: (paneId, text) => send('agent.prompt', { target: paneId, text }, 'agent_prompted'),
    async sendKeys(paneId, keys) {
      const bad = keys.find((key) => !isReplyKey(key))
      if (bad !== undefined) throw new HerdrProtocolError('invalid_key', `key not allowed: ${bad}`)
      await send('agent.send_keys', { target: paneId, keys }, 'ok')
    },
    sendText: (paneId, text) => send('pane.send_text', { pane_id: paneId, text }, 'ok'),
  }
}
