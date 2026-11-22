import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AgentStatus, Prompt, ReplyRequest } from '../shared/types'
import { ReplyPanel } from './ReplyPanel'
import type { ReplyResult } from './replyApi'

const FP = 'a'.repeat(64)

const permission: Prompt = {
  kind: 'permission',
  fingerprint: FP,
  tool: 'Bash command',
  request: 'npm test -- --run src/server\nRun the server unit tests',
  question: 'Do you want to proceed?',
  options: [
    { n: 1, label: 'Yes', description: null, approving: true },
    { n: 2, label: "Yes, and don't ask again for npm test", description: null, approving: true },
    {
      n: 3,
      label: 'No, and tell Claude what to do differently',
      description: null,
      approving: false,
    },
  ],
}

const choice: Prompt = {
  kind: 'choice',
  fingerprint: FP,
  header: 'Branch',
  question: 'Which branch should I use?',
  options: [
    { n: 1, label: 'main', description: 'The default branch', approving: false },
    { n: 2, label: 'feat/reply', description: null, approving: false },
    { n: 3, label: 'Type something.', description: null, approving: false },
  ],
  freeTextOption: 3,
}

const idle: Prompt = { kind: 'idle', fingerprint: FP }
const unrecognized: Prompt = { kind: 'unrecognized', fingerprint: FP }

type Send = (paneId: string, request: ReplyRequest) => Promise<ReplyResult>

interface Setup {
  prompt?: Prompt
  status?: AgentStatus
  disabled?: boolean
  send?: Send
}

function setup({ prompt = permission, status = 'blocked', disabled = false, send }: Setup = {}) {
  const sendMock = vi.fn<Send>(send ?? (() => Promise.resolve({ kind: 'sent' })))
  const onSent = vi.fn()
  const onPromptChanged = vi.fn()
  const view = render(
    <ReplyPanel
      paneId="w1:p1"
      name="meerkat-audit"
      prompt={prompt}
      status={status}
      disabled={disabled}
      onSent={onSent}
      onPromptChanged={onPromptChanged}
      send={sendMock}
    />
  )
  const actions = () => sendMock.mock.calls.map(([, request]) => request.action)
  return { ...view, send: sendMock, onSent, onPromptChanged, actions, user: userEvent.setup() }
}

describe('ReplyPanel permission', () => {
  it('shows the tool, the full request in a pre and one button per option', () => {
    const { container } = setup()
    expect(screen.getByText('Permission: Bash command')).toBeInTheDocument()
    const pre = container.querySelector('pre')
    expect(pre?.textContent).toBe(permission.kind === 'permission' ? permission.request : '')
    expect(screen.getByText('Do you want to proceed?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Yes' })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: "Yes, and don't ask again for npm test" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'No, and tell Claude what to do differently' })
    ).toBeInTheDocument()
  })

  it('asks for confirmation on an approving option, focuses Cancel and sends nothing', async () => {
    const { user, send } = setup()
    await user.click(screen.getByRole('button', { name: 'Yes' }))
    expect(
      screen.getByText('Send "Yes" to meerkat-audit? It will run the request above.')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    expect(send).not.toHaveBeenCalled()
  })

  it('Cancel closes the confirm without sending', async () => {
    const { user, send } = setup()
    await user.click(screen.getByRole('button', { name: 'Yes' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument()
    expect(send).not.toHaveBeenCalled()
  })

  it('Send in the confirm sends the option with the fingerprint and a fresh reply id', async () => {
    const { user, send, actions, onSent } = setup()
    await user.click(screen.getByRole('button', { name: "Yes, and don't ask again for npm test" }))
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(actions()).toEqual([{ type: 'option', n: 2 }])
    const request = send.mock.calls[0]?.[1]
    expect(send.mock.calls[0]?.[0]).toBe('w1:p1')
    expect(request?.fingerprint).toBe(FP)
    expect(request?.replyId).toMatch(/^[A-Za-z0-9-]{8,64}$/)
    expect(onSent).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Sent')).toBeInTheDocument()
  })

  it('sends a non-approving option without confirm', async () => {
    const { user, actions } = setup()
    await user.click(
      screen.getByRole('button', { name: 'No, and tell Claude what to do differently' })
    )
    expect(actions()).toEqual([{ type: 'option', n: 3 }])
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
  })

  it('uses a new reply id for every tap', async () => {
    const { user, send } = setup()
    const no = screen.getByRole('button', { name: 'No, and tell Claude what to do differently' })
    await user.click(no)
    await user.click(no)
    const ids = send.mock.calls.map(([, request]) => request.replyId)
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
  })

  it('disables buttons while in flight so a double click sends once', async () => {
    let finish: (result: ReplyResult) => void = () => undefined
    const { user, send } = setup({
      send: () => new Promise<ReplyResult>((resolve) => (finish = resolve)),
    })
    const no = screen.getByRole('button', { name: 'No, and tell Claude what to do differently' })
    await user.dblClick(no)
    expect(send).toHaveBeenCalledTimes(1)
    expect(no).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Yes' })).toBeDisabled()
    finish({ kind: 'sent' })
    await screen.findByText('Sent')
    expect(no).toBeEnabled()
  })

  it('swaps in the new prompt on prompt_changed and says so', async () => {
    const fresh: Prompt = { ...idle, fingerprint: 'b'.repeat(64) }
    const { user, onPromptChanged, onSent } = setup({
      send: () => Promise.resolve({ kind: 'prompt_changed', prompt: fresh }),
    })
    await user.click(
      screen.getByRole('button', { name: 'No, and tell Claude what to do differently' })
    )
    expect(onPromptChanged).toHaveBeenCalledWith(fresh)
    expect(onSent).not.toHaveBeenCalled()
    expect(await screen.findByText('The prompt changed, here is the new one')).toBeInTheDocument()
  })

  it('shows an error message inline', async () => {
    const { user } = setup({
      send: () => Promise.resolve({ kind: 'error', message: 'Herdr is not reachable' }),
    })
    await user.click(
      screen.getByRole('button', { name: 'No, and tell Claude what to do differently' })
    )
    expect(await screen.findByText('Herdr is not reachable')).toBeInTheDocument()
  })

  it('asks for a refetch after an unsure outcome and shows its message', async () => {
    const { user, onSent } = setup({
      send: () =>
        Promise.resolve({ kind: 'unsure', message: 'Could not reach Meerkat; check the output' }),
    })
    await user.click(
      screen.getByRole('button', { name: 'No, and tell Claude what to do differently' })
    )
    expect(await screen.findByText('Could not reach Meerkat; check the output')).toBeInTheDocument()
    expect(onSent).toHaveBeenCalledTimes(1)
  })

  it('drops an open confirm when the prompt changes underneath it', async () => {
    const { user, rerender, onSent, onPromptChanged, send } = setup()
    await user.click(screen.getByRole('button', { name: 'Yes' }))
    rerender(
      <ReplyPanel
        paneId="w1:p1"
        name="meerkat-audit"
        prompt={{ ...permission, fingerprint: 'c'.repeat(64) }}
        status="blocked"
        disabled={false}
        onSent={onSent}
        onPromptChanged={onPromptChanged}
        send={send}
      />
    )
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument()
  })
})

describe('ReplyPanel choice', () => {
  it('shows the question, option buttons with descriptions and the free-text option', async () => {
    const { user, actions } = setup({ prompt: choice })
    expect(screen.getByText('Branch')).toBeInTheDocument()
    expect(screen.getByText('Which branch should I use?')).toBeInTheDocument()
    expect(screen.getByText('The default branch')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /feat\/reply/ }))
    expect(actions()).toEqual([{ type: 'option', n: 2 }])
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
  })

  it('the free-text option opens a text box that sends freeText', async () => {
    const { user, actions } = setup({ prompt: choice })
    await user.click(screen.getByRole('button', { name: 'Type something.' }))
    await user.type(screen.getByRole('textbox', { name: 'Your answer' }), '  use develop  ')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(actions()).toEqual([{ type: 'freeText', text: 'use develop' }])
  })

  it('refuses a line break in the free-text answer with an inline message', async () => {
    const { user, send } = setup({ prompt: choice })
    await user.click(screen.getByRole('button', { name: 'Type something.' }))
    await user.type(screen.getByRole('textbox', { name: 'Your answer' }), 'one{Enter}two')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(screen.getByText("Line breaks can't be sent here")).toBeInTheDocument()
    expect(send).not.toHaveBeenCalled()
  })
})

describe('ReplyPanel idle', () => {
  it('shows a text box whose Send sends a prompt with newlines', async () => {
    const { user, actions } = setup({ prompt: idle, status: 'idle' })
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'continue{Enter}please')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(actions()).toEqual([{ type: 'prompt', text: 'continue\nplease' }])
  })

  it('⌘↩ sends', async () => {
    const { user, actions } = setup({ prompt: idle, status: 'done' })
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'continue')
    await user.keyboard('{Meta>}{Enter}{/Meta}')
    expect(actions()).toEqual([{ type: 'prompt', text: 'continue' }])
  })

  it('clears the text box after a successful send', async () => {
    const { user } = setup({ prompt: idle, status: 'idle' })
    const box = screen.getByRole('textbox', { name: 'Message' })
    await user.type(box, 'continue')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByText('Sent')
    expect(box).toHaveValue('')
  })

  it.each(['!ls', '/compact', '  /clear'])('labels %s as Send as command', async (text) => {
    const { user, actions } = setup({ prompt: idle, status: 'idle' })
    await user.type(screen.getByRole('textbox', { name: 'Message' }), text)
    await user.click(screen.getByRole('button', { name: 'Send as command' }))
    expect(actions()).toEqual([{ type: 'prompt', text: text.trim() }])
  })

  it('refuses empty and over-long text without sending', async () => {
    const { user, send } = setup({ prompt: idle, status: 'idle' })
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(screen.getByText('Type something first')).toBeInTheDocument()
    const box = screen.getByRole('textbox', { name: 'Message' })
    await user.click(box)
    await user.paste('x'.repeat(4001))
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(screen.getByText('Keep it to 4000 characters or fewer')).toBeInTheDocument()
    expect(send).not.toHaveBeenCalled()
  })
})

describe('ReplyPanel unrecognized', () => {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'Enter', 'Esc']

  it('shows the hint, a keypad and a text box', () => {
    setup({ prompt: unrecognized, status: 'blocked' })
    expect(
      screen.getByText("Meerkat couldn't read this prompt; check the output first.")
    ).toBeInTheDocument()
    for (const key of keys) expect(screen.getByRole('button', { name: key })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Text to type' })).toBeInTheDocument()
  })

  it.each([
    ['3', '3'],
    ['Enter', 'enter'],
  ])('blocked: %s goes through the confirm panel', async (label, key) => {
    const { user, actions } = setup({ prompt: unrecognized, status: 'blocked' })
    await user.click(screen.getByRole('button', { name: label }))
    expect(actions()).toEqual([])
    expect(
      screen.getByText(
        `Send "${label}" to meerkat-audit? This screen may be asking for permission; check the output above.`
      )
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    expect(screen.getByRole('textbox', { name: 'Text to type' })).toBeDisabled()
    const panel = screen.getByRole('group', { name: 'Confirm reply' })
    await user.click(within(panel).getByRole('button', { name: 'Send' }))
    expect(actions()).toEqual([{ type: 'keys', keys: [key] }])
  })

  it('blocked: Esc sends at once', async () => {
    const { user, actions } = setup({ prompt: unrecognized, status: 'blocked' })
    await user.click(screen.getByRole('button', { name: 'Esc' }))
    expect(actions()).toEqual([{ type: 'keys', keys: ['esc'] }])
  })

  it('blocked: typed text sends at once without Enter', async () => {
    const { user, actions } = setup({ prompt: unrecognized, status: 'blocked' })
    await user.type(screen.getByRole('textbox', { name: 'Text to type' }), 'yes please')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(actions()).toEqual([{ type: 'text', text: 'yes please' }])
  })

  it('unknown status: digits still go through the confirm panel', async () => {
    const { user, actions } = setup({ prompt: unrecognized, status: 'unknown' })
    await user.click(screen.getByRole('button', { name: '1' }))
    expect(actions()).toEqual([])
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
  })

  it.each<AgentStatus>(['idle', 'done'])(
    '%s (draft in the box): only Esc, no text box, no Enter, no digits',
    (status) => {
      setup({ prompt: unrecognized, status })
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Enter' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: '1' })).not.toBeInTheDocument()
      expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Esc'])
    }
  )

  it.each<AgentStatus>(['idle', 'done'])(
    '%s (draft in the box): Esc goes through the confirm panel',
    async (status) => {
      const { user, actions } = setup({ prompt: unrecognized, status })
      await user.click(screen.getByRole('button', { name: 'Esc' }))
      expect(actions()).toEqual([])
      expect(
        screen.getByText(
          'Send "Esc" to meerkat-audit? If this session is still running, Esc interrupts it; check the output above.'
        )
      ).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
      const panel = screen.getByRole('group', { name: 'Confirm reply' })
      await user.click(within(panel).getByRole('button', { name: 'Send' }))
      expect(actions()).toEqual([{ type: 'keys', keys: ['esc'] }])
    }
  )

  it('idle (draft in the box): cancelling the Esc confirm sends nothing', async () => {
    const { user, actions } = setup({ prompt: unrecognized, status: 'idle' })
    await user.click(screen.getByRole('button', { name: 'Esc' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('group', { name: 'Confirm reply' })).not.toBeInTheDocument()
    expect(actions()).toEqual([])
  })
})

describe('ReplyPanel visibility and state', () => {
  it('renders nothing while working', () => {
    const { container } = setup({ prompt: permission, status: 'working' })
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing for prompt none', () => {
    const { container } = setup({ prompt: { kind: 'none' }, status: 'blocked' })
    expect(container).toBeEmptyDOMElement()
  })

  it.each<Prompt>([permission, choice, idle, unrecognized])(
    'disables every control when Herdr is disconnected (%#)',
    (prompt) => {
      setup({ prompt, status: prompt.kind === 'idle' ? 'idle' : 'blocked', disabled: true })
      for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled()
      for (const box of screen.queryAllByRole('textbox')) expect(box).toBeDisabled()
    }
  )

  it('renders labels and the request as text, not markup', () => {
    const markup: Prompt = {
      kind: 'permission',
      fingerprint: FP,
      tool: '<i>Bash</i>',
      request: '<script>x()</script><b>rm</b>',
      question: '<u>Proceed?</u>',
      options: [{ n: 1, label: '<em>Yes</em>', description: null, approving: true }],
    }
    const { container } = setup({ prompt: markup })
    expect(container.querySelector('script, b, i, u, em')).toBeNull()
    expect(screen.getByText('<script>x()</script><b>rm</b>')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '<em>Yes</em>' })).toBeInTheDocument()
  })
})
