export const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  'session.snapshot',
  'events.subscribe',
  'events.wait',
  'agent.list',
  'agent.get',
  'agent.read',
])

export class MethodNotAllowedError extends Error {
  readonly method: string

  constructor(method: string) {
    super(`Herdr method not allowed: ${method}`)
    this.name = 'MethodNotAllowedError'
    this.method = method
  }
}

export function assertAllowed(method: string): void {
  if (!ALLOWED_METHODS.has(method)) {
    throw new MethodNotAllowedError(method)
  }
}
