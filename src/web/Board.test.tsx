import { act, render, renderHook, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BoardView, Card } from '../shared/types'
import { Banners } from './Banners'
import { Board } from './Board'
import { useNow } from './elapsed'

const now = 1_000_000_000

function card(overrides: Partial<Card> = {}): Card {
  return {
    paneId: 'p1',
    workspaceId: 'w-7',
    name: 'refactor auth',
    repo: 'acme/api',
    title: 'claude: fixing tests',
    status: 'working',
    since: now - 60_000,
    sinceIsLowerBound: false,
    progress: null,
    agent: 'claude',
    terminalId: 't1',
    statusEpoch: 0,
    lastReply: null,
    ...overrides,
  }
}

const empty: BoardView = { waiting: [], done: [], working: [], idle: [] }

describe('Board', () => {
  it('renders four regions in order with count badges', () => {
    const board: BoardView = {
      waiting: [card({ paneId: 'a', status: 'blocked' }), card({ paneId: 'b', status: 'blocked' })],
      done: [card({ paneId: 'c', status: 'done' })],
      working: [card()],
      idle: [],
    }
    render(<Board board={board} now={now} stale={false} onOpen={() => {}} />)
    const regions = screen.getAllByRole('region')
    expect(regions.map((region) => region.querySelector('h2 > span')?.textContent)).toEqual([
      'Waiting for you',
      'Done',
      'Working',
      'Idle',
    ])
    expect(regions.map((region) => region.querySelector('.badge')?.textContent)).toEqual([
      '2',
      '1',
      '1',
      '0',
    ])
  })

  it('shows the card fields', () => {
    render(
      <Board board={{ ...empty, working: [card()] }} now={now} stale={false} onOpen={() => {}} />
    )
    const button = screen.getByRole('button', { name: /refactor auth/ })
    expect(within(button).getByText('refactor auth')).toBeInTheDocument()
    expect(within(button).getByText('acme/api')).toBeInTheDocument()
    expect(within(button).getByText('claude: fixing tests')).toBeInTheDocument()
    expect(within(button).getByText('w-7')).toBeInTheDocument()
    expect(within(button).getByText('working')).toBeInTheDocument()
    expect(within(button).getByText('1m')).toBeInTheDocument()
  })

  it('shows (unnamed) for sessions without a name', () => {
    render(
      <Board
        board={{ ...empty, idle: [card({ name: null, status: 'idle' })] }}
        now={now}
        stale={false}
        onOpen={() => {}}
      />
    )
    expect(screen.getByText('(unnamed)')).toBeInTheDocument()
  })

  it('ticks elapsed time when now advances', () => {
    const board = { ...empty, working: [card()] }
    const { rerender } = render(<Board board={board} now={now} stale={false} onOpen={() => {}} />)
    expect(screen.getByText('1m')).toBeInTheDocument()
    rerender(<Board board={board} now={now + 60_000} stale={false} onOpen={() => {}} />)
    expect(screen.getByText('2m')).toBeInTheDocument()
  })

  function renderWorking(c: Card, at = now) {
    const board = { ...empty, working: [c] }
    const view = render(<Board board={board} now={at} stale={false} onOpen={() => {}} />)
    return { board, ...view }
  }

  it('shows the progress sentence and its age', () => {
    renderWorking(
      card({
        progress: { text: 'Parser tests pass.', since: now - 12_000, sinceIsLowerBound: false },
      })
    )
    expect(screen.getByText('Parser tests pass.')).toHaveClass('card-progress')
    expect(screen.getByText('updated 12s ago')).toBeInTheDocument()
  })

  it('marks a first-seen age as a lower bound', () => {
    renderWorking(
      card({ progress: { text: 'Working.', since: now - 180_000, sinceIsLowerBound: true } })
    )
    expect(screen.getByText('updated ≥ 3m ago')).toBeInTheDocument()
  })

  it('shows nothing extra without progress', () => {
    const { container } = renderWorking(card({ progress: null }))
    expect(screen.queryByText(/^updated /)).toBeNull()
    expect(container.querySelector('.card-progress')).toBeNull()
  })

  it('renders progress text as text, not HTML', () => {
    const { container } = renderWorking(
      card({ progress: { text: '<b>x</b>', since: now, sinceIsLowerBound: false } })
    )
    expect(screen.getByText('<b>x</b>')).toBeInTheDocument()
    expect(container.querySelector('.card b')).toBeNull()
  })

  it('ticks the progress age with now', () => {
    const c = card({ progress: { text: 'Going.', since: now, sinceIsLowerBound: false } })
    const { board, rerender } = renderWorking(c)
    rerender(<Board board={board} now={now + 60_000} stale={false} onOpen={() => {}} />)
    expect(screen.getByText('updated 1m ago')).toBeInTheDocument()
  })

  it.each([
    ['blocked', 'waiting'],
    ['done', 'done'],
    ['idle', 'idle'],
  ] as const)('shows the Reply label on a %s card', (status, column) => {
    const board = { ...empty, [column]: [card({ status })] }
    render(<Board board={board} now={now} stale={false} onOpen={() => {}} />)
    expect(screen.getByText('Reply')).toHaveClass('card-reply')
  })

  it.each(['working', 'unknown'] as const)('hides the Reply label on a %s card', (status) => {
    const board = { ...empty, working: [card({ status })] }
    render(<Board board={board} now={now} stale={false} onOpen={() => {}} />)
    expect(screen.queryByText('Reply')).toBeNull()
  })

  it('shows the last reply with its age', () => {
    const board = {
      ...empty,
      waiting: [
        card({
          status: 'blocked',
          lastReply: { summary: 'Answered "Yes"', at: now - 8_000, epoch: 0 },
        }),
      ],
    }
    render(<Board board={board} now={now} stale={false} onOpen={() => {}} />)
    expect(screen.getByText('Answered "Yes" from Meerkat · 8s ago')).toHaveClass('card-last-reply')
  })

  it('renders the last reply as text, not HTML', () => {
    const board = {
      ...empty,
      waiting: [
        card({
          status: 'blocked',
          lastReply: { summary: 'Typed "<b>x</b>"', at: now, epoch: 0 },
        }),
      ],
    }
    const { container } = render(<Board board={board} now={now} stale={false} onOpen={() => {}} />)
    expect(screen.getByText('Typed "<b>x</b>" from Meerkat · 0s ago')).toBeInTheDocument()
    expect(container.querySelector('.card b')).toBeNull()
  })

  it('shows no last reply line without one', () => {
    const board = { ...empty, waiting: [card({ status: 'blocked' })] }
    const { container } = render(<Board board={board} now={now} stale={false} onOpen={() => {}} />)
    expect(container.querySelector('.card-last-reply')).toBeNull()
  })

  it('calls onOpen on click and on Enter', async () => {
    const onOpen = vi.fn()
    const user = userEvent.setup()
    render(
      <Board board={{ ...empty, working: [card()] }} now={now} stale={false} onOpen={onOpen} />
    )
    await user.click(screen.getByRole('button', { name: /refactor auth/ }))
    expect(onOpen).toHaveBeenLastCalledWith('p1')
    onOpen.mockClear()
    screen.getByRole('button', { name: /refactor auth/ }).focus()
    await user.keyboard('{Enter}')
    expect(onOpen).toHaveBeenCalledWith('p1')
  })

  it('shows Nothing here in an empty column', () => {
    render(<Board board={empty} now={now} stale={false} onOpen={() => {}} />)
    expect(screen.getAllByText('Nothing here')).toHaveLength(4)
  })

  it('marks cards aria-disabled when stale', () => {
    render(
      <Board board={{ ...empty, working: [card()] }} now={now} stale={true} onOpen={() => {}} />
    )
    expect(screen.getByRole('button', { name: /refactor auth/ })).toHaveAttribute(
      'aria-disabled',
      'true'
    )
  })
})

describe('Banners', () => {
  it('shows the herdr banner', () => {
    render(<Banners herdr="disconnected" stream="open" />)
    expect(
      screen.getByText('Herdr is not reachable — showing last known state')
    ).toBeInTheDocument()
  })

  it('shows the stream banner', () => {
    render(<Banners herdr="connected" stream="lost" />)
    expect(screen.getByText('Meerkat server not reachable — retrying')).toBeInTheDocument()
  })

  it('shows no herdr banner while connecting', () => {
    const { container } = render(<Banners herdr="connecting" stream="open" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing otherwise', () => {
    const { container } = render(<Banners herdr="connected" stream="open" />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('useNow', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('advances on the interval and clears it on unmount', () => {
    vi.useFakeTimers()
    vi.setSystemTime(5_000)
    const { result, unmount } = renderHook(() => useNow(1000))
    expect(result.current).toBe(5_000)
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current).toBe(6_000)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
