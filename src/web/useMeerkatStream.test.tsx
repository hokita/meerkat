import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardView } from '../shared/types'
import { useMeerkatStream } from './useMeerkatStream'

type Listener = (event: { data?: string }) => void

class StubEventSource {
  static instances: StubEventSource[] = []
  url: string
  closed = false
  readyState = 0
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
    this.readyState = 2
  }

  failForGood() {
    this.readyState = 2
    this.emit('error')
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
  vi.useRealTimers()
  globalThis.EventSource = original
})

function latest(): StubEventSource {
  const source = StubEventSource.instances.at(-1)
  if (source === undefined) throw new Error('no EventSource created')
  return source
}

function closeAndWait(ms: number): void {
  act(() => latest().failForGood())
  act(() => vi.advanceTimersByTime(ms - 1))
}

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

  it('leaves reconnecting to the browser while the source is still retrying', () => {
    vi.useFakeTimers()
    renderHook(() => useMeerkatStream())
    act(() => latest().emit('error'))
    act(() => vi.advanceTimersByTime(20_000))
    expect(StubEventSource.instances).toHaveLength(1)
  })

  it('recreates a source closed for good with a doubling backoff capped at 10 s', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useMeerkatStream())
    for (const [index, delay] of [1000, 2000, 4000, 8000, 10_000, 10_000].entries()) {
      closeAndWait(delay)
      expect(StubEventSource.instances).toHaveLength(index + 1)
      expect(result.current.stream).toBe('lost')
      act(() => vi.advanceTimersByTime(1))
      expect(StubEventSource.instances).toHaveLength(index + 2)
      expect(latest().url).toBe('/api/events')
    }
  })

  it('resets the backoff once a recreated source opens', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useMeerkatStream())
    closeAndWait(1000)
    act(() => vi.advanceTimersByTime(1))
    closeAndWait(2000)
    act(() => vi.advanceTimersByTime(1))
    act(() => latest().emit('open'))
    expect(result.current.stream).toBe('open')
    closeAndWait(1000)
    expect(StubEventSource.instances).toHaveLength(3)
    act(() => vi.advanceTimersByTime(1))
    expect(StubEventSource.instances).toHaveLength(4)
  })

  it('applies messages from a recreated source', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useMeerkatStream())
    closeAndWait(1000)
    act(() => vi.advanceTimersByTime(1))
    act(() => latest().emit('connection', JSON.stringify({ herdr: 'connected' })))
    expect(result.current.herdr).toBe('connected')
  })

  it('cancels a pending recreation on unmount', () => {
    vi.useFakeTimers()
    const { unmount } = renderHook(() => useMeerkatStream())
    act(() => latest().failForGood())
    unmount()
    act(() => vi.advanceTimersByTime(20_000))
    expect(StubEventSource.instances).toHaveLength(1)
  })

  it('closes the recreated source on unmount', () => {
    vi.useFakeTimers()
    const { unmount } = renderHook(() => useMeerkatStream())
    closeAndWait(1000)
    act(() => vi.advanceTimersByTime(1))
    unmount()
    expect(latest().closed).toBe(true)
  })

  it('closes on unmount', () => {
    const { unmount } = renderHook(() => useMeerkatStream())
    unmount()
    expect(StubEventSource.instances[0]?.closed).toBe(true)
  })
})
