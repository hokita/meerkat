import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Card } from '../shared/types'
import { OutputDrawer } from './OutputDrawer'

function card(overrides: Partial<Card> = {}): Card {
  return {
    paneId: 'p1',
    workspaceId: 'w-7',
    name: 'refactor auth',
    repo: 'acme/api',
    title: null,
    status: 'working',
    since: 0,
    sinceIsLowerBound: false,
    ...overrides,
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function ok(text: string, truncated = false): Response {
  return json({ text, truncated })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OutputDrawer', () => {
  it('shows Loading… and then the text in a pre', async () => {
    const fetchOutput = vi.fn().mockResolvedValue(ok('line one\nline two'))
    render(<OutputDrawer paneId="p1" card={card()} onClose={vi.fn()} fetchOutput={fetchOutput} />)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    const pre = await screen.findByText(/line one/)
    expect(pre.tagName).toBe('PRE')
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
    expect(fetchOutput).toHaveBeenCalledWith('p1')
  })

  it('is a labelled dialog with the card name and repo', async () => {
    render(
      <OutputDrawer
        paneId="p1"
        card={card()}
        onClose={vi.fn()}
        fetchOutput={vi.fn().mockResolvedValue(ok('x'))}
      />
    )
    expect(screen.getByRole('dialog', { name: 'Output for refactor auth' })).toBeInTheDocument()
    expect(screen.getByText('acme/api')).toBeInTheDocument()
    await screen.findByText('x')
  })

  it('uses (unnamed) for a card without a name', async () => {
    render(
      <OutputDrawer
        paneId="p1"
        card={card({ name: null })}
        onClose={vi.fn()}
        fetchOutput={vi.fn().mockResolvedValue(ok('x'))}
      />
    )
    expect(screen.getByRole('dialog', { name: 'Output for (unnamed)' })).toBeInTheDocument()
    await screen.findByText('x')
  })

  it('moves focus to the Close button on open', async () => {
    render(
      <OutputDrawer
        paneId="p1"
        card={card()}
        onClose={vi.fn()}
        fetchOutput={vi.fn().mockResolvedValue(ok('x'))}
      />
    )
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()
    await screen.findByText('x')
  })

  it('shows the truncation note only when truncated', async () => {
    const { rerender } = render(
      <OutputDrawer
        paneId="p1"
        card={card()}
        onClose={vi.fn()}
        fetchOutput={vi.fn().mockResolvedValue(ok('a', true))}
      />
    )
    expect(await screen.findByText('Showing the last 40 lines')).toBeInTheDocument()
    rerender(
      <OutputDrawer
        paneId="p2"
        card={card({ paneId: 'p2' })}
        onClose={vi.fn()}
        fetchOutput={vi.fn().mockResolvedValue(ok('b', false))}
      />
    )
    await screen.findByText('b')
    expect(screen.queryByText('Showing the last 40 lines')).not.toBeInTheDocument()
  })

  it('Refresh fetches again', async () => {
    const user = userEvent.setup()
    const fetchOutput = vi
      .fn()
      .mockResolvedValueOnce(ok('first'))
      .mockResolvedValueOnce(ok('second'))
    render(<OutputDrawer paneId="p1" card={card()} onClose={vi.fn()} fetchOutput={fetchOutput} />)
    await screen.findByText('first')
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByText('second')).toBeInTheDocument()
    expect(fetchOutput).toHaveBeenCalledTimes(2)
  })

  it('Close and Escape call onClose', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <OutputDrawer
        paneId="p1"
        card={card()}
        onClose={onClose}
        fetchOutput={vi.fn().mockResolvedValue(ok('x'))}
      />
    )
    await screen.findByText('x')
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('renders markup in the output literally', async () => {
    const text = '<b>bold</b><script>x()</script>'
    const { container } = render(
      <OutputDrawer
        paneId="p1"
        card={card()}
        onClose={vi.fn()}
        fetchOutput={vi.fn().mockResolvedValue(ok(text))}
      />
    )
    expect(await screen.findByText(text)).toBeInTheDocument()
    expect(container.querySelector('pre b')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
  })

  it('shows Session closed, keeps the text and disables Refresh when the card goes null', async () => {
    const fetchOutput = vi.fn().mockResolvedValue(ok('last words'))
    const { rerender } = render(
      <OutputDrawer paneId="p1" card={card()} onClose={vi.fn()} fetchOutput={fetchOutput} />
    )
    await screen.findByText('last words')
    rerender(<OutputDrawer paneId="p1" card={null} onClose={vi.fn()} fetchOutput={fetchOutput} />)
    expect(screen.getByText('Session closed')).toBeInTheDocument()
    expect(screen.getByText('last words')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled()
    expect(screen.getByRole('dialog', { name: 'Output for refactor auth' })).toBeInTheDocument()
    expect(fetchOutput).toHaveBeenCalledTimes(1)
  })

  it('shows Session closed for a 404', async () => {
    render(
      <OutputDrawer
        paneId="p1"
        card={card()}
        onClose={vi.fn()}
        fetchOutput={vi.fn().mockResolvedValue(json({ error: 'session_closed' }, 404))}
      />
    )
    expect(await screen.findByText('Session closed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled()
  })

  it('shows Herdr is not reachable for a 503', async () => {
    render(
      <OutputDrawer
        paneId="p1"
        card={card()}
        onClose={vi.fn()}
        fetchOutput={vi.fn().mockResolvedValue(json({ error: 'herdr_disconnected' }, 503))}
      />
    )
    expect(await screen.findByText('Herdr is not reachable')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled()
  })

  it('shows Could not load output for a network error', async () => {
    render(
      <OutputDrawer
        paneId="p1"
        card={card()}
        onClose={vi.fn()}
        fetchOutput={vi.fn().mockRejectedValue(new TypeError('network'))}
      />
    )
    expect(await screen.findByText('Could not load output')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled()
  })

  it('shows Could not load output for a 502', async () => {
    render(
      <OutputDrawer
        paneId="p1"
        card={card()}
        onClose={vi.fn()}
        fetchOutput={vi.fn().mockResolvedValue(json({ error: 'herdr_error' }, 502))}
      />
    )
    expect(await screen.findByText('Could not load output')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled()
  })

  it('renders large output in a scroll container scrolled to the bottom', async () => {
    const setScrollTop = vi.fn()
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(5000)
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get: () => 0,
      set: setScrollTop,
    })
    const text = 'x'.repeat(64 * 1024)
    const { container } = render(
      <OutputDrawer
        paneId="p1"
        card={card()}
        onClose={vi.fn()}
        fetchOutput={vi.fn().mockResolvedValue(ok(text))}
      />
    )
    await waitFor(() => expect(container.querySelector('pre')).not.toBeNull())
    expect(container.querySelector('.drawer-scroll pre')).not.toBeNull()
    expect(setScrollTop).toHaveBeenLastCalledWith(5000)
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollTop')
  })

  it('ignores a response that arrives after the pane changed', async () => {
    let resolveFirst: (response: Response) => void = () => undefined
    const fetchOutput = vi
      .fn()
      .mockReturnValueOnce(new Promise<Response>((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce(ok('pane two'))
    const { rerender } = render(
      <OutputDrawer paneId="p1" card={card()} onClose={vi.fn()} fetchOutput={fetchOutput} />
    )
    rerender(
      <OutputDrawer
        paneId="p2"
        card={card({ paneId: 'p2' })}
        onClose={vi.fn()}
        fetchOutput={fetchOutput}
      />
    )
    await screen.findByText('pane two')
    resolveFirst(ok('pane one'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByText('pane one')).not.toBeInTheDocument()
    expect(screen.getByText('pane two')).toBeInTheDocument()
  })

  it('does not show the previous pane text while the next pane loads', async () => {
    const fetchOutput = vi
      .fn()
      .mockResolvedValueOnce(ok('pane one'))
      .mockReturnValueOnce(new Promise<Response>(() => undefined))
    const { rerender } = render(
      <OutputDrawer paneId="p1" card={card()} onClose={vi.fn()} fetchOutput={fetchOutput} />
    )
    await screen.findByText('pane one')
    rerender(
      <OutputDrawer
        paneId="p2"
        card={card({ paneId: 'p2' })}
        onClose={vi.fn()}
        fetchOutput={fetchOutput}
      />
    )
    expect(screen.queryByText('pane one')).not.toBeInTheDocument()
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('does not update state after unmount', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let resolve: (response: Response) => void = () => undefined
    const fetchOutput = vi.fn().mockReturnValue(new Promise<Response>((r) => (resolve = r)))
    const { unmount } = render(
      <OutputDrawer paneId="p1" card={card()} onClose={vi.fn()} fetchOutput={fetchOutput} />
    )
    unmount()
    resolve(ok('late'))
    await new Promise((r) => setTimeout(r, 0))
    expect(errors).not.toHaveBeenCalled()
  })
})
