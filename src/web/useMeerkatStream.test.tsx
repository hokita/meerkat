import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BoardView } from '../shared/types'
import { useMeerkatStream } from './useMeerkatStream'

type Listener = (event: { data?: string }) => void

class StubEventSource {
  static instances: StubEventSource[] = []
  url: string
  closed = false
  listeners = new Map<string, Listener[]>()

  constructor(url: string) {
    this.url = url
    StubEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== listener)
    )
  }

  close() {
    this.closed = true
  }

  emit(type: string, data?: string) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data })
  }
}

const original = globalThis.EventSource
const board: BoardView = { attention: [], working: [], idle: [] }

beforeEach(() => {
  StubEventSource.instances = []
  globalThis.EventSource = StubEventSource as unknown as typeof EventSource
})

afterEach(() => {
  globalThis.EventSource = original
})

describe('useMeerkatStream', () => {
  it('connects to the events endpoint and starts as connecting', () => {
    const { result } = renderHook(() => useMeerkatStream())
    expect(StubEventSource.instances[0]?.url).toBe('/api/events')
    expect(result.current).toEqual({ board: null, herdr: null, stream: 'connecting' })
  })

  it('becomes open on open', () => {
    const { result } = renderHook(() => useMeerkatStream())
    act(() => StubEventSource.instances[0]?.emit('open'))
    expect(result.current.stream).toBe('open')
  })

  it('stores board and connection messages', () => {
    const { result } = renderHook(() => useMeerkatStream())
    act(() => {
      StubEventSource.instances[0]?.emit('board', JSON.stringify(board))
      StubEventSource.instances[0]?.emit('connection', JSON.stringify({ herdr: 'disconnected' }))
    })
    expect(result.current.board).toEqual(board)
    expect(result.current.herdr).toBe('disconnected')
  })

  it('stores a connecting Herdr', () => {
    const { result } = renderHook(() => useMeerkatStream())
    act(() => {
      StubEventSource.instances[0]?.emit('connection', JSON.stringify({ herdr: 'connecting' }))
    })
    expect(result.current.herdr).toBe('connecting')
  })

  it('ignores malformed messages', () => {
    const { result } = renderHook(() => useMeerkatStream())
    act(() => {
      StubEventSource.instances[0]?.emit('board', '{nope')
      StubEventSource.instances[0]?.emit('connection', '{nope')
    })
    expect(result.current.board).toBeNull()
    expect(result.current.herdr).toBeNull()
  })

  it('becomes lost on error and open again on reopen', () => {
    const { result } = renderHook(() => useMeerkatStream())
    act(() => StubEventSource.instances[0]?.emit('error'))
    expect(result.current.stream).toBe('lost')
    act(() => StubEventSource.instances[0]?.emit('open'))
    expect(result.current.stream).toBe('open')
  })

  it('closes on unmount', () => {
    const { unmount } = renderHook(() => useMeerkatStream())
    unmount()
    expect(StubEventSource.instances[0]?.closed).toBe(true)
  })
})
