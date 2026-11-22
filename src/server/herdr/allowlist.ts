export const READ_METHODS: ReadonlySet<string> = new Set([
  'session.snapshot',
  'events.subscribe',
  'events.wait',
  'agent.list',
  'agent.get',
  'agent.read',
])

export const REPLY_METHODS: ReadonlySet<string> = new Set([
  'agent.prompt',
  'agent.send_keys',
  'pane.send_text',
])

export class MethodNotAllowedError extends Error {
  readonly method: string

  constructor(method: string) {
    super(`Herdr method not allowed: ${method}`)
    this.name = 'MethodNotAllowedError'
    this.method = method
  }
}

export function assertReadAllowed(method: string): void {
  if (!READ_METHODS.has(method)) {
    throw new MethodNotAllowedError(method)
  }
}

export function assertReplyAllowed(method: string): void {
  if (!REPLY_METHODS.has(method)) {
    throw new MethodNotAllowedError(method)
  }
}
