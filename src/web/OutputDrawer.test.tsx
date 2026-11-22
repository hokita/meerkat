import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Card, Prompt, ReplyRequest } from '../shared/types'
import { OutputDrawer } from './OutputDrawer'
import type { ReplyResult } from './replyApi'

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
    progress: null,
    agent: 'claude',
    terminalId: 't1',
    statusEpoch: 0,
    lastReply: null,
    ...overrides,
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function ok(text: string, truncated = false, prompt: Prompt = { kind: 'none' }): Response {
  return json({ text, truncated, prompt })
}

const permission: Prompt = {
  kind: 'permission',
  fingerprint: 'a'.repeat(64),
  tool: 'Bash command',
  request: 'npm test',
  question: 'Do you want to proceed?',
  options: [
    { n: 1, label: 'Yes', description: null, approving: true },
    { n: 2, label: 'No', description: null, approving: false },
  ],
}

const unrecognized: Prompt = { kind: 'unrecognized', fingerprint: 'b'.repeat(64) }

type Send = (paneId: string, request: ReplyRequest) => Promise<ReplyResult>

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

  describe('reply panel', () => {
    function drawer(
      fetchOutput: (paneId: string) => Promise<Response>,
      send: Send,
      overrides: Partial<Card> = { status: 'blocked' },
      herdrConnected = true
    ) {
      return (
        <OutputDrawer
          paneId="p1"
          card={card(overrides)}
          onClose={vi.fn()}
          fetchOutput={fetchOutput}
          herdrConnected={herdrConnected}
          send={send}
        />
      )
    }

    it('shows the reply panel above the output for a recognized prompt', async () => {
      const send = vi.fn<Send>()
      render(drawer(vi.fn().mockResolvedValue(ok('screen', false, permission)), send))
      const panel = await screen.findByRole('region', { name: 'Reply' })
      const output = screen.getByText('screen')
      expect(panel.compareDocumentPosition(output) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(within(panel).getByText('Permission: Bash command')).toBeInTheDocument()
    })

    it('shows an unrecognized panel below the output it refers to', async () => {
      render(drawer(vi.fn().mockResolvedValue(ok('screen', false, unrecognized)), vi.fn<Send>()))
      const panel = await screen.findByRole('region', { name: 'Reply' })
      const output = screen.getByText('screen')
      expect(panel.compareDocumentPosition(output) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    })

    it('shows no panel while the card is working', async () => {
      render(
        drawer(vi.fn().mockResolvedValue(ok('screen', false, permission)), vi.fn<Send>(), {
          status: 'working',
        })
      )
      await screen.findByText('screen')
      expect(screen.queryByRole('region', { name: 'Reply' })).not.toBeInTheDocument()
    })

    it('shows no panel when the output response has no prompt', async () => {
      render(
        drawer(vi.fn().mockResolvedValue(json({ text: 'screen', truncated: false })), vi.fn<Send>())
      )
      await screen.findByText('screen')
      expect(screen.queryByRole('region', { name: 'Reply' })).not.toBeInTheDocument()
    })

    it('disables the controls when Herdr is disconnected', async () => {
      render(
        drawer(
          vi.fn().mockResolvedValue(ok('screen', false, permission)),
          vi.fn<Send>(),
          { status: 'blocked' },
          false
        )
      )
      const panel = await screen.findByRole('region', { name: 'Reply' })
      for (const button of within(panel).getAllByRole('button')) expect(button).toBeDisabled()
    })

    it('refetches the output once after a successful send', async () => {
      const user = userEvent.setup()
      const fetchOutput = vi
        .fn()
        .mockResolvedValueOnce(ok('before', false, permission))
        .mockResolvedValueOnce(ok('after'))
      const send = vi.fn<Send>().mockResolvedValue({ kind: 'sent' })
      render(drawer(fetchOutput, send))
      await screen.findByText('before')
      await user.click(screen.getByRole('button', { name: 'No' }))
      expect(await screen.findByText('after')).toBeInTheDocument()
      expect(fetchOutput).toHaveBeenCalledTimes(2)
      expect(send.mock.calls[0]?.[1].action).toEqual({ type: 'option', n: 2 })
      expect(screen.queryByRole('region', { name: 'Reply' })).not.toBeInTheDocument()
    })

    it('swaps in the new prompt on prompt_changed and refreshes the output it belongs to', async () => {
      const user = userEvent.setup()
      const fresh: Prompt = { ...permission, fingerprint: 'c'.repeat(64), request: 'npm run lint' }
      let finishRefresh: (response: Response) => void = () => undefined
      const fetchOutput = vi
        .fn()
        .mockResolvedValueOnce(ok('before', false, permission))
        .mockReturnValueOnce(new Promise<Response>((resolve) => (finishRefresh = resolve)))
      const send = vi.fn<Send>().mockResolvedValue({ kind: 'prompt_changed', prompt: fresh })
      render(drawer(fetchOutput, send))
      await screen.findByText('before')
      await user.click(screen.getByRole('button', { name: 'No' }))
      expect(await screen.findByText('The prompt changed, here is the new one')).toBeInTheDocument()
      expect(screen.getByText('npm run lint')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'No' })).toBeDisabled()
      finishRefresh(ok('after', false, fresh))
      await screen.findByText('after')
      expect(screen.getByRole('button', { name: 'No' })).toBeEnabled()
      expect(screen.getByText('The prompt changed, here is the new one')).toBeInTheDocument()
    })

    it('keeps the panel notice when the prompt moves the panel above the output', async () => {
      const user = userEvent.setup()
      const fetchOutput = vi
        .fn()
        .mockResolvedValueOnce(ok('before', false, unrecognized))
        .mockResolvedValueOnce(ok('after', false, permission))
      const send = vi.fn<Send>().mockResolvedValue({ kind: 'prompt_changed', prompt: permission })
      render(drawer(fetchOutput, send))
      await screen.findByText('before')
      await user.click(screen.getByRole('button', { name: 'Esc' }))
      await screen.findByText('after')
      const panel = screen.getByRole('region', { name: 'Reply' })
      expect(within(panel).getByText('Permission: Bash command')).toBeInTheDocument()
      expect(within(panel).getByText('The prompt changed, here is the new one')).toBeInTheDocument()
    })

    it('refetches when the status epoch changes and never offers the old prompt meanwhile', async () => {
      const second: Prompt = {
        ...permission,
        fingerprint: 'd'.repeat(64),
        request: 'rm -rf build',
        options: [{ n: 1, label: 'Allow B', description: null, approving: true }],
      }
      let finishRefetch: (response: Response) => void = () => undefined
      const refetch = new Promise<Response>((resolve) => (finishRefetch = resolve))
      const fetchOutput = vi
        .fn()
        .mockResolvedValueOnce(ok('screen A', false, permission))
        .mockImplementation(() => refetch.then((response) => response.clone()))
      const send = vi.fn<Send>()
      const { rerender } = render(drawer(fetchOutput, send, { status: 'blocked', statusEpoch: 1 }))
      await screen.findByText('Permission: Bash command')
      rerender(drawer(fetchOutput, send, { status: 'working', statusEpoch: 2 }))
      rerender(drawer(fetchOutput, send, { status: 'blocked', statusEpoch: 3 }))
      expect(screen.queryByText('npm test')).not.toBeInTheDocument()
      for (const button of screen.queryAllByRole('button', { name: /Yes|No/ })) {
        expect(button).toBeDisabled()
      }
      expect(screen.queryByRole('button', { name: 'Yes' })).not.toBeInTheDocument()
      finishRefetch(ok('screen B', false, second))
      expect(await screen.findByText('rm -rf build')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Allow B' })).toBeEnabled()
      expect(fetchOutput.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(send).not.toHaveBeenCalled()
    })

    it('refetches the output after an unsure outcome', async () => {
      const user = userEvent.setup()
      const fetchOutput = vi
        .fn()
        .mockResolvedValueOnce(ok('before', false, permission))
        .mockResolvedValueOnce(ok('after'))
      const send = vi
        .fn<Send>()
        .mockResolvedValue({ kind: 'unsure', message: 'Could not reach Meerkat' })
      render(drawer(fetchOutput, send))
      await screen.findByText('before')
      await user.click(screen.getByRole('button', { name: 'No' }))
      expect(await screen.findByText('after')).toBeInTheDocument()
      expect(fetchOutput).toHaveBeenCalledTimes(2)
    })

    it('shows no panel for a malformed prompt but still shows the output', async () => {
      const malformed = { kind: 'permission', fingerprint: 'a'.repeat(64), tool: 'Bash' }
      render(
        drawer(
          vi.fn().mockResolvedValue(json({ text: 'screen', truncated: false, prompt: malformed })),
          vi.fn<Send>()
        )
      )
      expect(await screen.findByText('screen')).toBeInTheDocument()
      expect(screen.queryByRole('region', { name: 'Reply' })).not.toBeInTheDocument()
    })

    it('hides the panel when a refresh fails, so stale output is never answered', async () => {
      const user = userEvent.setup()
      const fetchOutput = vi
        .fn()
        .mockResolvedValueOnce(ok('before', false, unrecognized))
        .mockResolvedValueOnce(json({ error: 'herdr_disconnected' }, 503))
      render(drawer(fetchOutput, vi.fn<Send>()))
      await screen.findByRole('region', { name: 'Reply' })
      await user.click(screen.getByRole('button', { name: 'Refresh' }))
      await screen.findByText('Herdr is not reachable')
      expect(screen.getByText('before')).toBeInTheDocument()
      expect(screen.queryByRole('region', { name: 'Reply' })).not.toBeInTheDocument()
    })

    it('shows no panel once the session closed', async () => {
      const fetchOutput = vi.fn().mockResolvedValue(ok('screen', false, permission))
      const send = vi.fn<Send>()
      const { rerender } = render(drawer(fetchOutput, send))
      await screen.findByRole('region', { name: 'Reply' })
      rerender(
        <OutputDrawer
          paneId="p1"
          card={null}
          onClose={vi.fn()}
          fetchOutput={fetchOutput}
          herdrConnected
          send={send}
        />
      )
      expect(screen.queryByRole('region', { name: 'Reply' })).not.toBeInTheDocument()
    })

    it('keeps the output a text child when a prompt is shown', async () => {
      const text = '<b>bold</b>'
      const { container } = render(
        drawer(vi.fn().mockResolvedValue(ok(text, false, unrecognized)), vi.fn<Send>())
      )
      expect(await screen.findByText(text)).toBeInTheDocument()
      expect(container.querySelector('b')).toBeNull()
    })
  })
})
