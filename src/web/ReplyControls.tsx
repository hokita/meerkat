import { useEffect, useRef, useState } from 'react'
import { REPLY_KEYS, type PromptOption, type ReplyKey } from '../shared/types'
import { checkReplyText } from './replyApi'

export const KEY_LABELS: Record<ReplyKey, string> = {
  '1': '1',
  '2': '2',
  '3': '3',
  '4': '4',
  '5': '5',
  '6': '6',
  '7': '7',
  '8': '8',
  '9': '9',
  enter: 'Enter',
  esc: 'Esc',
}

interface ConfirmPanelProps {
  message: string
  disabled: boolean
  onCancel: () => void
  onSend: () => void
}

export function ConfirmPanel({ message, disabled, onCancel, onSend }: ConfirmPanelProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  return (
    <div className="reply-confirm" role="group" aria-label="Confirm reply">
      <p className="reply-confirm-message">{message}</p>
      <div className="reply-row">
        <button
          type="button"
          className="drawer-button"
          ref={cancelRef}
          disabled={disabled}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="drawer-button reply-send"
          disabled={disabled}
          onClick={onSend}
        >
          Send
        </button>
      </div>
    </div>
  )
}

interface OptionButtonsProps {
  options: PromptOption[]
  disabled: boolean
  onPick: (option: PromptOption) => void
}

export function OptionButtons({ options, disabled, onPick }: OptionButtonsProps) {
  return (
    <div className="reply-options">
      {options.map((option) => (
        <button
          key={option.n}
          type="button"
          className="drawer-button reply-option"
          disabled={disabled}
          onClick={() => onPick(option)}
        >
          <span className="reply-option-label">{option.label}</span>
          {option.description !== null && (
            <span className="reply-option-description">{option.description}</span>
          )}
        </button>
      ))}
    </div>
  )
}

interface KeypadProps {
  keys?: readonly ReplyKey[]
  disabled: boolean
  onPress: (key: ReplyKey) => void
}

export function Keypad({ keys = REPLY_KEYS, disabled, onPress }: KeypadProps) {
  return (
    <div className="reply-keypad" role="group" aria-label="Keys">
      {keys.map((key) => (
        <button
          key={key}
          type="button"
          className="drawer-button reply-key"
          disabled={disabled}
          onClick={() => onPress(key)}
        >
          {KEY_LABELS[key]}
        </button>
      ))}
    </div>
  )
}

interface TextReplyProps {
  label: string
  value: string
  newlines: boolean
  commands: boolean
  disabled: boolean
  onChange: (value: string) => void
  onSend: (text: string) => void
}

function looksLikeCommand(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.startsWith('!') || trimmed.startsWith('/')
}

export function TextReply({
  label,
  value,
  newlines,
  commands,
  disabled,
  onChange,
  onSend,
}: TextReplyProps) {
  const [problem, setProblem] = useState<string | null>(null)

  function submit() {
    const found = checkReplyText(value, newlines)
    setProblem(found)
    if (found === null) onSend(value.trim())
  }

  return (
    <div className="reply-text">
      <textarea
        className="reply-textarea"
        aria-label={label}
        rows={3}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          setProblem(null)
          onChange(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && event.metaKey) {
            event.preventDefault()
            submit()
          }
        }}
      />
      <div className="reply-row">
        <button
          type="button"
          className="drawer-button reply-send"
          disabled={disabled}
          onClick={submit}
        >
          {commands && looksLikeCommand(value) ? 'Send as command' : 'Send'}
        </button>
        <span className="reply-hint">⌘↩ sends</span>
      </div>
      {problem !== null && (
        <p className="reply-problem" role="alert">
          {problem}
        </p>
      )}
    </div>
  )
}
