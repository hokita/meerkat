import { useState } from 'react'
import type {
  AgentStatus,
  Prompt,
  PromptOption,
  ReplyAction,
  ReplyKey,
  ReplyRequest,
} from '../shared/types'
import { sendReply, type ReplyResult } from './replyApi'
import { ConfirmPanel, KEY_LABELS, Keypad, OptionButtons, TextReply } from './ReplyControls'

interface ReplyPanelProps {
  paneId: string
  name: string
  prompt: Prompt
  status: AgentStatus
  disabled: boolean
  onSent: () => void
  onPromptChanged: (prompt: Prompt) => void
  send?: (paneId: string, request: ReplyRequest) => Promise<ReplyResult>
}

type Waiting = Exclude<Prompt, { kind: 'none' }>

interface Pending {
  fingerprint: string
  message: string
  action: ReplyAction
}

interface Draft {
  kind: string
  text: string
}

interface TextBox {
  label: string
  newlines: boolean
  commands: boolean
  action: (text: string) => ReplyAction
}

const ESC_ONLY: readonly ReplyKey[] = ['esc']
const UNREAD_HINT = "Meerkat couldn't read this prompt; check the output first."
const CHANGED = 'The prompt changed, here is the new one'

function textBoxFor(prompt: Waiting, status: AgentStatus, freeTextOpen: boolean): TextBox | null {
  switch (prompt.kind) {
    case 'choice':
      if (!freeTextOpen) return null
      return {
        label: 'Your answer',
        newlines: false,
        commands: false,
        action: (text) => ({ type: 'freeText', text }),
      }
    case 'idle':
      return {
        label: 'Message',
        newlines: true,
        commands: true,
        action: (text) => ({ type: 'prompt', text }),
      }
    case 'unrecognized':
      if (isDraftScreen(status)) return null
      return {
        label: 'Text to type',
        newlines: false,
        commands: true,
        action: (text) => ({ type: 'text', text }),
      }
    case 'permission':
      return null
  }
}

function isDraftScreen(status: AgentStatus): boolean {
  return status === 'idle' || status === 'done'
}

export function ReplyPanel({
  paneId,
  name,
  prompt,
  status,
  disabled,
  onSent,
  onPromptChanged,
  send = sendReply,
}: ReplyPanelProps) {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [draft, setDraft] = useState<Draft>({ kind: '', text: '' })
  const [freeTextFor, setFreeTextFor] = useState<string | null>(null)

  if (prompt.kind === 'none' || status === 'working') return null
  const waiting = prompt

  async function submit(action: ReplyAction) {
    setBusy(true)
    setPending(null)
    setNotice(null)
    const result = await send(paneId, {
      replyId: crypto.randomUUID(),
      fingerprint: waiting.fingerprint,
      action,
    })
    if (result.kind === 'reloading') return
    setBusy(false)
    if (result.kind === 'sent') {
      setDraft({ kind: '', text: '' })
      setNotice('Sent')
      onSent()
    } else if (result.kind === 'unsure') {
      setNotice(result.message)
      onSent()
    } else if (result.kind === 'prompt_changed') {
      setNotice(CHANGED)
      onPromptChanged(result.prompt)
    } else {
      setNotice(result.message)
    }
  }

  function confirm(message: string, action: ReplyAction) {
    setNotice(null)
    setPending({ fingerprint: waiting.fingerprint, message, action })
  }

  function pickOption(option: PromptOption) {
    const action: ReplyAction = { type: 'option', n: option.n }
    if (option.approving) {
      confirm(`Send "${option.label}" to ${name}? It will run the request above.`, action)
    } else {
      void submit(action)
    }
  }

  function pressKey(key: ReplyKey) {
    const action: ReplyAction = { type: 'keys', keys: [key] }
    if (key === 'esc') {
      void submit(action)
    } else {
      confirm(
        `Send "${KEY_LABELS[key]}" to ${name}? This screen may be asking for permission; check the output above.`,
        action
      )
    }
  }

  const confirming =
    pending !== null && pending.fingerprint === waiting.fingerprint ? pending : null
  const locked = disabled || busy || confirming !== null

  const text = textBoxFor(waiting, status, freeTextFor === waiting.fingerprint)

  return (
    <section className="reply-panel" aria-label="Reply">
      {waiting.kind === 'permission' && (
        <>
          <div className="reply-request">
            <p className="reply-title">Permission: {waiting.tool}</p>
            <pre className="reply-request-text">{waiting.request}</pre>
          </div>
          <p className="reply-question">{waiting.question}</p>
          <OptionButtons options={waiting.options} disabled={locked} onPick={pickOption} />
        </>
      )}
      {waiting.kind === 'choice' && (
        <>
          {waiting.header !== null && <p className="reply-title">{waiting.header}</p>}
          <p className="reply-question">{waiting.question}</p>
          <OptionButtons
            options={waiting.options.filter((option) => option.n !== waiting.freeTextOption)}
            disabled={locked}
            onPick={pickOption}
          />
          {waiting.options
            .filter((option) => option.n === waiting.freeTextOption)
            .map((option) => (
              <button
                key={option.n}
                type="button"
                className="drawer-button reply-option"
                aria-expanded={freeTextFor === waiting.fingerprint}
                disabled={locked}
                onClick={() =>
                  setFreeTextFor((open) =>
                    open === waiting.fingerprint ? null : waiting.fingerprint
                  )
                }
              >
                {option.label}
              </button>
            ))}
        </>
      )}
      {waiting.kind === 'unrecognized' && (
        <>
          <p className="reply-question">{UNREAD_HINT}</p>
          {isDraftScreen(status) ? (
            <>
              <p className="reply-hint">
                The prompt box may hold a draft typed in the terminal, so only Esc is offered.
              </p>
              <Keypad keys={ESC_ONLY} disabled={locked} onPress={pressKey} />
            </>
          ) : (
            <Keypad disabled={locked} onPress={pressKey} />
          )}
        </>
      )}
      {text !== null && (
        <TextReply
          label={text.label}
          value={draft.kind === waiting.kind ? draft.text : ''}
          newlines={text.newlines}
          commands={text.commands}
          disabled={locked}
          onChange={(value) => setDraft({ kind: waiting.kind, text: value })}
          onSend={(value) => void submit(text.action(value))}
        />
      )}
      {confirming !== null && (
        <ConfirmPanel
          key={confirming.message}
          message={confirming.message}
          disabled={disabled || busy}
          onCancel={() => setPending(null)}
          onSend={() => void submit(confirming.action)}
        />
      )}
      {notice !== null && (
        <p className="reply-notice" role="status">
          {notice}
        </p>
      )}
    </section>
  )
}
