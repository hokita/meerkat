import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { sanitizeOutput } from './output.js'
import { hasIdleBoxText, recognize } from './prompt.js'

const NBSP = ' '
const ESC = '\u001b'

function raw(name: string): string {
  return readFileSync(new URL(`../../test-support/screens/${name}`, import.meta.url), 'utf8')
}

function screen(name: string): string {
  return sanitizeOutput(raw(name)).text
}

function edit(text: string, from: string, to: string): string {
  const at = text.lastIndexOf(from)
  expect(at).toBeGreaterThanOrEqual(0)
  return text.slice(0, at) + to + text.slice(at + from.length)
}

function lines(text: string): string[] {
  return text.split('\n')
}

function dropLine(text: string, predicate: (line: string) => boolean): string {
  const all = lines(text)
  const index = all.findIndex(predicate)
  expect(index).toBeGreaterThanOrEqual(0)
  all.splice(index, 1)
  return all.join('\n')
}

const isRule = (line: string) => /^─{3,}$/.test(line.trimEnd())

const BASH_TIP =
  ' Tip: auto mode handles these prompts for you — choose "switch to auto mode" below'

describe('recognize: permission prompts', () => {
  it('reads the Bash permission fixture', () => {
    const prompt = recognize(screen('permission-bash.txt'), 'blocked', 'claude')
    expect(prompt.kind).toBe('permission')
    if (prompt.kind !== 'permission') return
    expect(prompt.tool).toBe('Bash command')
    expect(prompt.question).toBe('Do you want to proceed?')
    const requestLines = lines(prompt.request)
    expect(requestLines).toHaveLength(5)
    expect(requestLines[0]).toBe(BASH_TIP)
    expect(requestLines[1]).toBe(' Create empty file made-by-bash.txt')
    expect(requestLines[2]).toMatch(/^╌{40,}$/)
    expect(requestLines[3]).toBe(' touch made-by-bash.txt')
    expect(requestLines[4]).toMatch(/^╌{40,}$/)
    expect(prompt.options).toEqual([
      { n: 1, label: 'Yes', description: null, approving: true },
      {
        n: 2,
        label: 'Yes, and always allow access to /tmp/scratch from this project',
        description: null,
        approving: true,
      },
      {
        n: 3,
        label: 'Yes, and switch to auto mode · auto mode handles these prompts for you',
        description: null,
        approving: true,
      },
      { n: 4, label: 'No', description: null, approving: false },
    ])
  })

  it('reads the file-create permission fixture', () => {
    const prompt = recognize(screen('permission-edit.txt'), 'blocked', 'claude')
    expect(prompt.kind).toBe('permission')
    if (prompt.kind !== 'permission') return
    expect(prompt.tool).toBe('Create file')
    expect(prompt.question).toBe('Do you want to create notes.txt?')
    const requestLines = lines(prompt.request)
    expect(requestLines).toHaveLength(4)
    expect(requestLines[0]).toBe(' notes.txt')
    expect(requestLines[1]).toMatch(/^╌{40,}$/)
    expect(requestLines[2]).toBe('  1 hi')
    expect(requestLines[3]).toMatch(/^╌{40,}$/)
    expect(prompt.options.map((o) => [o.n, o.approving])).toEqual([
      [1, true],
      [2, true],
      [3, false],
    ])
    expect(prompt.options[1]?.label).toBe(
      'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)'
    )
  })

  it('treats a label it does not know as approving', () => {
    const text = edit(screen('permission-bash.txt'), '4. No', '4. Maybe later')
    const prompt = recognize(text, 'blocked', 'claude')
    expect(prompt.kind).toBe('permission')
    if (prompt.kind !== 'permission') return
    expect(prompt.options[3]).toEqual({
      n: 4,
      label: 'Maybe later',
      description: null,
      approving: true,
    })
  })

  it('only treats the word No as not approving', () => {
    const text = edit(screen('permission-bash.txt'), '4. No', '4. Nowhere near')
    const prompt = recognize(text, 'blocked', 'claude')
    expect(prompt.kind).toBe('permission')
    if (prompt.kind !== 'permission') return
    expect(prompt.options[3]?.approving).toBe(true)
  })

  it('is unrecognized for a bare Esc to cancel footer', () => {
    const text = edit(
      screen('permission-bash.txt'),
      'Esc to cancel · Tab to amend',
      'Esc to cancel'
    )
    expect(recognize(text, 'blocked', 'claude').kind).toBe('unrecognized')
  })

  it('accepts the observed footer in any case and spacing', () => {
    const text = edit(
      screen('permission-bash.txt'),
      'Esc to cancel · Tab to amend',
      'esc  to cancel ·  TAB to amend'
    )
    expect(recognize(text, 'blocked', 'claude').kind).toBe('permission')
  })

  it('keeps a numbered line inside the request as request text, not an option', () => {
    const text = edit(
      screen('permission-bash.txt'),
      ' touch made-by-bash.txt',
      ' touch made-by-bash.txt\n 1. foo'
    )
    const prompt = recognize(text, 'blocked', 'claude')
    expect(prompt.kind).toBe('permission')
    if (prompt.kind !== 'permission') return
    expect(prompt.request).toContain('\n 1. foo\n')
    expect(prompt.options.map((o) => o.label)).toEqual([
      'Yes',
      'Yes, and always allow access to /tmp/scratch from this project',
      'Yes, and switch to auto mode · auto mode handles these prompts for you',
      'No',
    ])
  })

  it('is unrecognized when numbering has a gap', () => {
    const text = edit(screen('permission-bash.txt'), '3. Yes, and switch', '5. Yes, and switch')
    expect(recognize(text, 'blocked', 'claude').kind).toBe('unrecognized')
  })

  it('is unrecognized when numbering does not start at 1', () => {
    let text = screen('permission-edit.txt')
    text = edit(text, '❯ 1. Yes', '❯ 2. Yes')
    text = edit(text, '2. Yes, and switch', '3. Yes, and switch')
    text = edit(text, '3. No', '4. No')
    expect(recognize(text, 'blocked', 'claude').kind).toBe('unrecognized')
  })

  it('is unrecognized with two ❯ markers', () => {
    const text = edit(screen('permission-bash.txt'), '   4. No', ' ❯ 4. No')
    expect(recognize(text, 'blocked', 'claude').kind).toBe('unrecognized')
  })

  it('is unrecognized with no ❯ marker', () => {
    const text = edit(screen('permission-bash.txt'), ' ❯ 1. Yes', '   1. Yes')
    expect(recognize(text, 'blocked', 'claude').kind).toBe('unrecognized')
  })

  it('is unrecognized with ten options', () => {
    const extra = Array.from({ length: 6 }, (_, i) => `   ${i + 5}. Yes again ${i}`).join('\n')
    const text = edit(screen('permission-bash.txt'), '   4. No', `   4. No\n${extra}`)
    expect(recognize(text, 'blocked', 'claude').kind).toBe('unrecognized')
  })

  it('is unrecognized when the footer is missing', () => {
    const text = dropLine(screen('permission-bash.txt'), (l) => l.includes('Esc to cancel'))
    expect(recognize(text, 'blocked', 'claude').kind).toBe('unrecognized')
  })

  it('is unrecognized when the footer is different', () => {
    const text = edit(screen('permission-bash.txt'), 'Esc to cancel · Tab to amend', 'Esc to quit')
    expect(recognize(text, 'blocked', 'claude').kind).toBe('unrecognized')
  })

  it('is unrecognized when text follows the footer', () => {
    const text = edit(
      screen('permission-bash.txt'),
      'Esc to cancel · Tab to amend',
      'Esc to cancel · Tab to amend\n something else'
    )
    expect(recognize(text, 'blocked', 'claude').kind).toBe('unrecognized')
  })

  it('is unrecognized when the rule line above the request is missing', () => {
    const text = dropLine(screen('permission-bash.txt'), isRule)
    expect(recognize(text, 'blocked', 'claude').kind).toBe('unrecognized')
  })

  it('is unrecognized when a long request starts above the read window', () => {
    const all = lines(screen('permission-bash.txt'))
    const touch = all.findIndex((l) => l === ' touch made-by-bash.txt')
    const text = all.slice(touch).join('\n')
    expect(recognize(text, 'blocked', 'claude').kind).toBe('unrecognized')
  })

  it('is unrecognized when the request is empty', () => {
    const all = lines(screen('permission-bash.txt'))
    const rule = all.findLastIndex(isRule)
    const question = all.findIndex((l) => l.includes('Do you want to proceed?'))
    const titleOnly = [...all.slice(0, rule + 1), ' Bash command', ...all.slice(question)]
    expect(recognize(titleOnly.join('\n'), 'blocked', 'claude').kind).toBe('unrecognized')
    const nothing = [...all.slice(0, rule + 1), ...all.slice(question)]
    expect(recognize(nothing.join('\n'), 'blocked', 'claude').kind).toBe('unrecognized')
  })

  it('is unrecognized when the question line is not a Do you want to question', () => {
    const text = edit(screen('permission-bash.txt'), 'Do you want to proceed?', 'Proceed?')
    expect(recognize(text, 'blocked', 'claude').kind).toBe('unrecognized')
  })

  it('is unrecognized when a blank line separates the question from the options', () => {
    const text = edit(
      screen('permission-bash.txt'),
      'Do you want to proceed?',
      'Do you want to proceed?\n'
    )
    expect(recognize(text, 'blocked', 'claude').kind).toBe('unrecognized')
  })

  it('is unrecognized when the screen is a permission prompt but the status is idle', () => {
    expect(recognize(screen('permission-bash.txt'), 'idle', 'claude').kind).toBe('unrecognized')
  })

  it('is unrecognized for the folder trust dialog', () => {
    expect(recognize(screen('trust.txt'), 'blocked', 'claude').kind).toBe('unrecognized')
  })
})

describe('recognize: choice lists', () => {
  it('reads the single-question choice fixture', () => {
    expect(recognize(screen('choice-single.txt'), 'blocked', 'claude')).toEqual({
      kind: 'choice',
      header: 'Color',
      question: 'Which color should the note use?',
      options: [
        { n: 1, label: 'Red', description: 'A warm color', approving: false },
        { n: 2, label: 'Blue', description: 'A cool color', approving: false },
        { n: 3, label: 'Type something.', description: null, approving: false },
        { n: 4, label: 'Chat about this', description: null, approving: false },
      ],
      freeTextOption: 3,
    })
  })

  it('reads a choice with no header line', () => {
    const text = dropLine(screen('choice-single.txt'), (l) => l.trim() === '☐ Color')
    const prompt = recognize(text, 'blocked', 'claude')
    expect(prompt.kind).toBe('choice')
    if (prompt.kind !== 'choice') return
    expect(prompt.header).toBeNull()
  })

  it('gives no free-text option when there is no Type something. option', () => {
    let text = screen('choice-single.txt')
    text = edit(text, '3. Type something.', '3. Green')
    const prompt = recognize(text, 'blocked', 'claude')
    expect(prompt.kind).toBe('choice')
    if (prompt.kind !== 'choice') return
    expect(prompt.freeTextOption).toBeNull()
  })

  it('is unrecognized for a multi-select list', () => {
    expect(recognize(screen('choice-multiselect.txt'), 'blocked', 'claude').kind).toBe(
      'unrecognized'
    )
  })

  it('is unrecognized for a multi-select list even without its tab strip', () => {
    const text = edit(screen('choice-multiselect.txt'), '←  ☐ Toppings  ✔ Submit  →', ' ☐ Toppings')
    expect(recognize(text, 'blocked', 'claude').kind).toBe('unrecognized')
  })

  it('is unrecognized for a Submit line even without checkboxes or a tab strip', () => {
    let text = edit(screen('choice-multiselect.txt'), '←  ☐ Toppings  ✔ Submit  →', ' ☐ Toppings')
    for (const label of ['Cheese', 'Olives', 'Type something']) {
      text = edit(text, `[ ] ${label}`, label)
    }
    expect(text).toContain('     Submit')
    expect(recognize(text, 'blocked', 'claude').kind).toBe('unrecognized')
  })

  it('is unrecognized for a tabbed form', () => {
    expect(recognize(screen('choice-tabbed.txt'), 'blocked', 'claude').kind).toBe('unrecognized')
  })

  it('is unrecognized for a tab strip even with the single-question footer', () => {
    const text = edit(
      screen('choice-tabbed.txt'),
      'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
      'Enter to select · ↑/↓ to navigate · Esc to cancel'
    )
    expect(recognize(text, 'blocked', 'claude').kind).toBe('unrecognized')
  })

  it('is unrecognized when the type-your-own field is focused or filled', () => {
    expect(recognize(screen('choice-type-focused.txt'), 'blocked', 'claude').kind).toBe(
      'unrecognized'
    )
    expect(recognize(screen('choice-type-filled.txt'), 'blocked', 'claude').kind).toBe(
      'unrecognized'
    )
  })

  it('is unrecognized when something besides Chat about this sits below the inner rule', () => {
    const text = edit(
      screen('choice-single.txt'),
      '  4. Chat about this',
      '  4. Chat about this\nhi'
    )
    expect(recognize(text, 'blocked', 'claude').kind).toBe('unrecognized')
  })

  it('is unrecognized when Type something. is not just before Chat about this', () => {
    let text = screen('choice-single.txt')
    text = edit(text, '2. Blue', '2. Type something.')
    text = edit(text, '3. Type something.', '3. Blue')
    expect(recognize(text, 'blocked', 'claude').kind).toBe('unrecognized')
  })

  it('is unrecognized when an option has a checkbox', () => {
    const text = edit(screen('choice-single.txt'), '1. Red', '1. [x] Red')
    expect(recognize(text, 'blocked', 'claude').kind).toBe('unrecognized')
  })

  it('is unrecognized when the question does not end in ?', () => {
    const text = edit(
      screen('choice-single.txt'),
      'Which color should the note use?',
      'Pick a color'
    )
    expect(recognize(text, 'blocked', 'claude').kind).toBe('unrecognized')
  })

  it('is unrecognized when extra text sits above the question', () => {
    const text = edit(screen('choice-single.txt'), ' ☐ Color', ' ☐ Color\nSomething else')
    expect(recognize(text, 'blocked', 'claude').kind).toBe('unrecognized')
  })

  it('is unrecognized when the inner rule has no outer rule above it', () => {
    const all = lines(screen('choice-single.txt'))
    const onlyFromInner = all.slice(all.findLastIndex(isRule))
    expect(recognize(onlyFromInner.join('\n'), 'blocked', 'claude').kind).toBe('unrecognized')
  })

  it('is unrecognized when the choice screen is read while idle', () => {
    expect(recognize(screen('choice-single.txt'), 'idle', 'claude').kind).toBe('unrecognized')
  })
})

describe('recognize: idle prompt box', () => {
  it('reads an empty prompt box as idle', () => {
    expect(recognize(screen('idle-empty.txt'), 'idle', 'claude')).toEqual({ kind: 'idle' })
    expect(recognize(screen('idle-empty.txt'), 'done', 'claude')).toEqual({ kind: 'idle' })
  })

  it('is unrecognized for an empty box while blocked', () => {
    expect(recognize(screen('idle-empty.txt'), 'blocked', 'claude').kind).toBe('unrecognized')
  })

  it('reads a prose numbered list above an empty box as idle, never a choice', () => {
    expect(recognize(screen('prose-list-idle.txt'), 'idle', 'claude')).toEqual({ kind: 'idle' })
  })

  it('is unrecognized for a prose numbered list while blocked', () => {
    expect(recognize(screen('prose-list-idle.txt'), 'blocked', 'claude').kind).toBe('unrecognized')
  })

  it('is unrecognized for text in the box without an ANSI read', () => {
    for (const name of ['idle-draft.txt', 'idle-placeholder.txt', 'idle-suggestion.txt']) {
      expect(recognize(screen(name), 'idle', 'claude').kind).toBe('unrecognized')
    }
  })

  it('is unrecognized when the box has more than one line', () => {
    const all = lines(screen('idle-empty.txt'))
    const box = all.findLastIndex((l) => l === '❯')
    all.splice(box + 1, 0, '  more')
    const text = all.join('\n')
    expect(recognize(text, 'idle', 'claude').kind).toBe('unrecognized')
  })

  it('is unrecognized when the session is still interrupting', () => {
    const text = edit(
      screen('idle-empty.txt'),
      '⏸ manual mode on · ? for shortcuts',
      '⏸ manual mode on · esc to interrupt'
    )
    expect(recognize(text, 'idle', 'claude').kind).toBe('unrecognized')
  })

  it('is unrecognized when an active spinner sits above the box', () => {
    const all = lines(screen('idle-empty.txt'))
    const rules = all.flatMap((l, i) => (isRule(l) ? [i] : []))
    all.splice(rules[rules.length - 2] ?? 0, 0, '· Flummoxing… (44s · ↓ 2.3k tokens)', '')
    expect(recognize(all.join('\n'), 'idle', 'claude').kind).toBe('unrecognized')
  })

  it('is unrecognized when only one rule is on screen', () => {
    const text = dropLine(screen('idle-empty.txt'), isRule)
    expect(recognize(text, 'idle', 'claude').kind).toBe('unrecognized')
  })
})

describe('recognize: dim suggestion in the box (ANSI)', () => {
  const ansi = raw('idle-suggestion.ansi.txt')
  const suggestionText = edit(
    screen('idle-suggestion.txt'),
    `❯${NBSP}ls -la made-by-bash.txt`,
    `❯${NBSP}run the tests again`
  )

  it('fixture box line is a faint suggestion', () => {
    expect(ansi).toContain(`❯ ${ESC}[0m${ESC}[2mrun the tests again${ESC}[0m`)
  })

  it('reads a fully faint suggestion as idle', () => {
    expect(recognize(suggestionText, 'idle', 'claude', ansi)).toEqual({ kind: 'idle' })
  })

  it('reads a faint placeholder as idle', () => {
    const placeholder = ansi.replace('run the tests again', 'Try "fix lint errors"')
    expect(recognize(screen('idle-placeholder.txt'), 'done', 'claude', placeholder)).toEqual({
      kind: 'idle',
    })
  })

  it('is unrecognized when the same line has no faint attribute', () => {
    const plain = ansi.replace(`${ESC}[2m`, '')
    expect(recognize(suggestionText, 'idle', 'claude', plain).kind).toBe('unrecognized')
  })

  it('is unrecognized when the line is only partly faint', () => {
    const partial = ansi.replace('run the tests again', `run the ${ESC}[0mtests again`)
    expect(recognize(suggestionText, 'idle', 'claude', partial).kind).toBe('unrecognized')
  })

  it('is unrecognized when faint is turned off by SGR 22', () => {
    const partial = ansi.replace('run the tests again', `run the tests ${ESC}[22magain`)
    expect(recognize(suggestionText, 'idle', 'claude', partial).kind).toBe('unrecognized')
  })

  it('is unrecognized when a cursor cell is drawn without faint', () => {
    const cursor = ansi.replace(
      `run the tests again${ESC}[0m`,
      `run the tests agai${ESC}[0m${ESC}[7mn${ESC}[0m`
    )
    expect(recognize(suggestionText, 'idle', 'claude', cursor).kind).toBe('unrecognized')
  })

  it('stays idle when colour and bold codes leave faint on', () => {
    const styled = ansi.replace(
      `${ESC}[2mrun the tests again`,
      `${ESC}[2;38;2;1;2;3mrun the ${ESC}[1;38;5;7;48;5;9mtests again`
    )
    expect(recognize(suggestionText, 'idle', 'claude', styled)).toEqual({ kind: 'idle' })
  })

  it('is unrecognized for an SGR it cannot parse', () => {
    const odd = ansi.replace(`${ESC}[2m`, `${ESC}[2;38:2::1:2:3m`)
    expect(recognize(suggestionText, 'idle', 'claude', odd).kind).toBe('unrecognized')
  })

  it('is unrecognized for a non-SGR escape sequence in the box', () => {
    const odd = ansi.replace('run the', `run${ESC}[5C the`)
    expect(recognize(suggestionText, 'idle', 'claude', odd).kind).toBe('unrecognized')
  })

  it('is unrecognized when the ANSI box text differs from the text read', () => {
    expect(recognize(screen('idle-suggestion.txt'), 'idle', 'claude', ansi).kind).toBe(
      'unrecognized'
    )
  })

  it('is unrecognized when the ANSI box is not found', () => {
    expect(recognize(suggestionText, 'idle', 'claude', 'nothing here\r\n').kind).toBe(
      'unrecognized'
    )
  })

  it('is unrecognized when the ANSI box has more than one line', () => {
    const multi = ansi.replace(
      `${ESC}[0m\r\n${ESC}[0m${ESC}[38;2`,
      `${ESC}[0m\r\n  x\r\n${ESC}[0m${ESC}[38;2`
    )
    expect(multi).not.toBe(ansi)
    expect(recognize(suggestionText, 'idle', 'claude', multi).kind).toBe('unrecognized')
  })

  it('is unrecognized for a draft drawn with no SGR at all', () => {
    const rule = '─'.repeat(40)
    const draft = `${rule}\r\n❯ half typed draft\r\n${rule}\r\n`
    expect(recognize(screen('idle-draft.txt'), 'idle', 'claude', draft).kind).toBe('unrecognized')
  })

  const osc8 = `${ESC}]8;;https://example.com${ESC}\\link${ESC}]8;;${ESC}\\`
  const unknownSgr = `${ESC}[73mraised${ESC}[0m`

  it('ignores unsupported sequences above the box', () => {
    const noisy = `earlier ${osc8} and ${unknownSgr}\r\n${ESC}[?25l\r\n${ansi}`
    expect(recognize(suggestionText, 'idle', 'claude', noisy)).toEqual({ kind: 'idle' })
  })

  it('is unrecognized for an OSC 8 link inside the box', () => {
    const inside = ansi.replace('run the tests again', `run the tests ${osc8}`)
    const text = edit(suggestionText, 'run the tests again', 'run the tests link')
    expect(recognize(text, 'idle', 'claude', inside).kind).toBe('unrecognized')
  })

  it('is unrecognized for an unknown SGR code inside the box', () => {
    const inside = ansi.replace('run the tests again', `run the tests ${ESC}[73magain`)
    expect(recognize(suggestionText, 'idle', 'claude', inside).kind).toBe('unrecognized')
  })

  it('does not carry faint into the box from above the rule', () => {
    const plain = ansi.replace(`${ESC}[2m`, '').replace(`${ESC}[0m\r\n❯`, '\r\n❯')
    const leaking = `${ESC}[2m\r\n${plain.replaceAll(`${ESC}[0m`, '')}`
    expect(recognize(suggestionText, 'idle', 'claude', leaking).kind).toBe('unrecognized')
  })

  it('ignores the ANSI read when the box is empty', () => {
    expect(recognize(screen('idle-empty.txt'), 'idle', 'claude', 'garbage')).toEqual({
      kind: 'idle',
    })
  })
})

describe('recognize: status and agent', () => {
  it('gives none while working, whatever the screen', () => {
    for (const name of ['permission-bash.txt', 'choice-single.txt', 'idle-empty.txt']) {
      expect(recognize(screen(name), 'working', 'claude')).toEqual({ kind: 'none' })
      expect(recognize(screen(name), 'working', 'codex')).toEqual({ kind: 'none' })
    }
  })

  it('is unrecognized for another agent', () => {
    expect(recognize(screen('permission-bash.txt'), 'blocked', 'codex').kind).toBe('unrecognized')
    expect(recognize(screen('idle-empty.txt'), 'idle', 'codex').kind).toBe('unrecognized')
    expect(recognize(screen('permission-bash.txt'), 'blocked', null).kind).toBe('unrecognized')
  })

  it('is unrecognized for an unknown status', () => {
    expect(recognize(screen('permission-bash.txt'), 'unknown', 'claude').kind).toBe('unrecognized')
    expect(recognize(screen('idle-empty.txt'), 'unknown', 'claude').kind).toBe('unrecognized')
  })

  it('is unrecognized for an empty screen', () => {
    expect(recognize('', 'blocked', 'claude').kind).toBe('unrecognized')
    expect(recognize('', 'idle', 'claude').kind).toBe('unrecognized')
  })
})

describe('hasIdleBoxText', () => {
  it('is true when the screen is idle except for text in the box', () => {
    expect(hasIdleBoxText(screen('idle-draft.txt'), 'idle', 'claude')).toBe(true)
    expect(hasIdleBoxText(screen('idle-suggestion.txt'), 'done', 'claude')).toBe(true)
    expect(hasIdleBoxText(screen('idle-placeholder.txt'), 'idle', 'claude')).toBe(true)
  })

  it('is false for an empty box, another status, another agent, or a dialog', () => {
    expect(hasIdleBoxText(screen('idle-empty.txt'), 'idle', 'claude')).toBe(false)
    expect(hasIdleBoxText(screen('idle-draft.txt'), 'blocked', 'claude')).toBe(false)
    expect(hasIdleBoxText(screen('idle-draft.txt'), 'working', 'claude')).toBe(false)
    expect(hasIdleBoxText(screen('idle-draft.txt'), 'idle', 'codex')).toBe(false)
    expect(hasIdleBoxText(screen('choice-single.txt'), 'idle', 'claude')).toBe(false)
  })
})
