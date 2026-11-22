# Reply from the board: design

Date: 2026-11-22. Status: approved by the user on 2026-11-22. Builds on card-progress (merged to main as
`7b3e76b`).
Items marked **(my call)** were decided by the designer, not the user. **(builder's call)** items may be
settled by the builder within the bounds given.

## Intent

The user wants to answer Claude sessions' questions from Meerkat instead of switching to that session's
terminal. Success: a session lands in Needs attention, the user opens its card, sees exactly what it asks, taps
an answer (or types one), and the card shows the answer went in, without leaving the board.

## Goals

Three kinds of answer, all decided with the user:

1. **Choice list.** Claude asks with numbered options (AskUserQuestion-style, including "Type something").
   Meerkat shows one button per option and a text box for the type-your-own option.
2. **Permission prompt.** "Do you want to proceed? 1. Yes 2. Yes, and don't ask again… 3. No…". Meerkat shows
   the full tool request (tool name and the whole command or file path) and one button per option. Any
   approving option needs a second, explicit confirm before it is sent.
3. **Waiting at the prompt.** The session is idle or done at its `❯` input. Meerkat shows a text box; Send
   submits the message (e.g. "continue").

Anything not recognized with certainty gets the output (last 40 lines), a text box and a keypad
(`1`–`9`, `Enter`, `Esc`). Meerkat never guesses which buttons a screen means.

Any session on the board can be answered: the user's own and workers.

## Non-goals

- iPhone or other-device access. Mac only, `127.0.0.1` only, as today.
- Starting, closing, focusing, renaming, splitting or interrupting anything. No Ctrl+C.
- Answering non-Claude agents with buttons (they get the keypad fallback only).
- Multi-select questions and multi-question (tabbed) AskUserQuestion forms get buttons **(my call: no)**; they
  get the keypad fallback in this version.
- Notifications, history of replies across restarts, sign-in.
- Telling the orchestrator through any side channel. It learns from the session's own output.

## Anti-goals (a failure even if it works)

- A web page other than Meerkat's own can make Meerkat send anything to a session.
- An answer lands on a screen the user did not see (a newer question, another session, another agent in the
  same pane).
- A double tap sends an answer twice.
- "Yes" goes out on a permission prompt without the user having seen the full command and confirmed.
- Any Herdr method other than the three reply methods below becomes reachable, from any route.

## Approaches (A chosen by the user)

- **A (chosen): recognize and show real buttons.** Meerkat parses Claude Code's choice list and permission
  prompt from the screen, shows labelled buttons and the full request, confirms approvals, and falls back to a
  keypad plus text box for everything else. Costs a parser that must track Claude Code's UI; fails safe.
- **B: keypad and text only.** No parsing; the user reads the output and taps `1`, `Enter`, etc. Smaller, but
  approving a command means reading raw terminal text and there is no confirm tied to what was approved.

A is B plus recognition on top, so B is exactly A's fallback path.

## Screen formats and recognition rules

Input: `agent.read` (`recent_unwrapped`, text, ANSI stripped), sanitized as today, **120 lines** for
recognition **(my call: long commands overflow 40)**; the drawer still shows the last 40.

**Read size while blocked (found in Task 0).** Herdr refuses `agent.read` with more `lines` than the pane's
viewport rows while the agent is `blocked` (`agent_not_idle`: "its alternate-screen history can only be
captured by scrolling while idle"). With a 60-row pane, 60 lines worked and 61 failed. So for a `blocked`
pane the reader asks for 120 lines and, on `agent_not_idle`, reads once more with `source: 'visible'` (the
whole viewport, which always holds the dialog, since Claude Code draws it at the bottom). Any other error, or
a second failure, gives `unrecognized` with no output, so nothing can be sent against it. The same limit hits
card-progress's existing 120-line read on blocked panes; it fails there today and should use the same
fallback.

Evidence. Herdr 0.9.5's own Claude detection rules (`herdr agent explain <pane> --json`, read-only) classify
`blocked` by these strings in the region after the last horizontal rule: `do you want to proceed?` with
`esc to cancel` (permission), and the footer
`Enter to select · ↑/↓ to navigate · Esc to cancel` (also `Enter to confirm · Esc to cancel`, and
`arrow keys`/`↑↓` variants) for forms. Every captured dialog fixture reads as `blocked` with
`herdr agent explain --file <fixture> --agent claude`, and every idle fixture as `idle` (`live_prompt_box`).

Real screens, captured on 2026-11-22 from Claude Code v2.1.323 in a scratch session (Task 0), are in
`test-support/screens/*.txt`. Horizontal rules are the full terminal width there; they are shortened below.

Idle prompt box (`idle-empty.txt`):

```
✻ Worked for 8s · done 21:48

──────────────────────────────────────────────
❯
──────────────────────────────────────────────
  ⏸ manual mode on · ? for shortcuts · ← 1 agent
```

Permission prompt, Bash (`permission-bash.txt`). The command sits between two dashed `╌` lines, which are not
horizontal rules:

```
──────────────────────────────────────────────
 Bash command
 Tip: auto mode handles these prompts for you — choose "switch to auto mode" below
 Create empty file made-by-bash.txt
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 touch made-by-bash.txt
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to /tmp/scratch from this project
   3. Yes, and switch to auto mode · auto mode handles these prompts for you
   4. No

 Esc to cancel · Tab to amend
```

Permission prompt, file create (`permission-edit.txt`):

```
──────────────────────────────────────────────
 Create file
 notes.txt
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
  1 hi
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to create notes.txt?
 ❯ 1. Yes
   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)
   3. No

 Esc to cancel · Tab to amend
```

Choice list, single question (`choice-single.txt`). A horizontal rule sits **inside** the dialog, between the
last answer and the extra `Chat about this` option, so the dialog spans the last two rules:

```
──────────────────────────────────────────────
 ☐ Color

Which color should the note use?

❯ 1. Red
     A warm color
  2. Blue
     A cool color
  3. Type something.
──────────────────────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
```

After the type-your-own number is pressed (`choice-type-focused.txt`) the marker moves to it and the footer
becomes `Enter to select · ↑/↓ to navigate · ctrl+g to edit in Vim · Esc to cancel`; typed text replaces the
label in place (`❯ 3. Medium please`, `choice-type-filled.txt`).

Multi-select (`choice-multiselect.txt`): header line `←  ☐ Toppings  ✔ Submit  →`, options
`❯ 1. [ ] Cheese`, an unnumbered `Submit` line. Two questions (`choice-tabbed.txt`): header line
`←  ☐ Shape  ☐ Font  ✔ Submit  →`, footer `Enter to select · Tab/Arrow keys to navigate · Esc to cancel`.
Folder trust at start (`trust.txt`): unnumbered options `❯ No, exit` / `Yes, I trust this folder`, footer
`Enter to confirm · Esc to cancel`.

Idle look-alikes: `idle-draft.txt` (`❯ half typed draft`), `idle-placeholder.txt` (a fresh session shows
`❯ Try "fix lint errors"`), `idle-suggestion.txt` (after a turn Claude Code may show a suggested next prompt,
`❯ ls -la made-by-bash.txt`), `prose-list-idle.txt` (a numbered list in Claude's reply, then an empty box).
Placeholder and suggestion are dim (SGR 2) in the ANSI read but identical to a draft in the text read.
`idle-suggestion.ansi.txt` holds the prompt box of the ANSI read (`source: 'visible', format: 'ansi'`) with
the suggestion words replaced by neutral ones: the rules are `ESC[0m ESC[38;2;136;136;136m ─… ESC[0m` and the
line is `❯ ESC[0m ESC[2m<suggestion> ESC[0m`, lines ending in `\r\n`. The placeholder line had exactly the
same styling. No ANSI read of an empty box or of a draft was kept, so tests build those from the text
fixtures (a draft drawn with no SGR at all must read as a draft).

Rules. A screen is recognized only if **all** hold; any miss gives `unrecognized`:

1. Herdr's status for the pane is `blocked` (from the board), and the agent is `claude`.
2. The block is everything after the **last** horizontal rule (`─{3,}` line; `╌` lines are not rules). It ends
   with a known footer (exact text, case-insensitive, whitespace-normalized): for a permission prompt
   `Esc to cancel` or `Esc to cancel · Tab to amend`; for a choice list exactly
   `Enter to select · ↑/↓ to navigate · Esc to cancel`. If the block's only option line is
   `n. Chat about this`, the block is extended upward to the second-to-last rule (the inner rule is dropped),
   and that must hold the rest of the dialog. Any other shape: `unrecognized`.
3. Options are lines `^\s*(❯\s+)?(\d+)\.\s+(.+)$`, numbered `1..n` with no gaps, `n ≤ 9`, exactly one with the
   `❯` marker. Indented lines directly under an option are its description.
4. **Permission** if the line just above the options is a question starting `Do you want to` and ending in
   `?` (`Do you want to proceed?`, `Do you want to create notes.txt?`, `Do you want to make this edit to
   <file>?`). The request is every line between the rule and that question: first non-blank line is the tool
   title (`Bash command`, `Create file`, …), the rest (including `Tip:` lines and the `╌` lines) is shown
   verbatim in a `<pre>`. If the request is empty, `unrecognized`.
5. **Choice** if a header line that is exactly `☐ <header>` (one box, no `←`/`→`, no `✔`) or no header is
   followed by a question line ending in `?`, then options. The type-your-own option is the last option
   before `Chat about this` whose label is `Type something.`. `Chat about this` is shown as an ordinary
   option. A tab strip (`←`, `→`, `✔`, more than one `☐`), `[ ]`/`[x]` checkboxes, or a `Submit` line means
   multi-question or multi-select: `unrecognized`. The focused type-your-own state (footer with
   `ctrl+g to edit in Vim`) is `unrecognized`, which is safe: `freeText` sends all its steps in one request.
6. **Idle prompt** if Herdr's status is `idle` or `done` and the block after the second-to-last rule is a
   prompt box whose line starts with `❯` (empty or with the user's half-typed draft). A non-empty draft means
   `unrecognized` **(my call: Meerkat must not append to text the user typed in the terminal)**. The text read
   cannot tell Claude Code's dim placeholder (`Try "fix lint errors"`) or suggested next prompt from a draft,
   so when the text read shows anything after `❯` in the idle box, Meerkat does **one** extra read,
   `agent.read {source: 'visible', format: 'ansi', strip_ansi: false}`, finds the same prompt box (the `❯`
   line between the last two rules) and parses its SGR sequences. The box counts as **empty** only if every
   non-whitespace character after `❯` is drawn while the faint attribute (SGR `2`) is on, as in
   `idle-suggestion.ansi.txt` (`❯ ESC[0m ESC[2m<text> ESC[0m`). Any character drawn without faint, an SGR
   sequence Meerkat can't parse, a box that isn't found, a box whose text differs from the text read, a
   multi-line box, or a failed read means **draft** → `unrecognized`. Only the text read is fingerprinted (the
   suggestion text included), so a new suggestion changes the fingerprint. Sending is unchanged: `prompt` is
   `agent.prompt`, which in Task 0 replaced a showing suggestion with the pasted text and submitted it.
7. Approving options: any permission option whose label starts with `Yes`, **and any label Meerkat doesn't
   know** (fail safe). Only labels starting with `No` skip the confirm.

The parser is a pure function `recognize(text, status, agent) → Prompt` with tests built from the fixtures.

## Herdr input methods (verified 2026-11-22, herdr 0.9.5, `herdr api schema --json`)

- `agent.prompt` `{target, text, wait?}`: bracketed paste + Enter as one submission. **Rejects** a blocked
  agent with `agent_blocked` before sending. Used for the idle prompt only; no `wait`.
- `agent.send_keys` `{target, keys: string[]}`: logical key names (`esc`, `ctrl+c` are documented); Herdr
  validates every key before writing. Used for options and the keypad.
- `pane.send_text` `{pane_id, text}`: literal text, no Enter. The only way to type into a dialog (the
  type-your-own field, or the text box on an unrecognized screen) because `agent.prompt` refuses blocked
  agents. Followed by `agent.send_keys ["enter"]` only when the user taps Send.

There is no `agent.send_text`. Not used: `pane.send_keys`, `pane.send_input`, `pane.run`, and everything else.

### Verified in the scratch session (Task 0, 2026-11-22, Claude Code v2.1.323)

- **A digit alone selects and submits.** Permission prompt: `send_keys ["1"]` ran the command at once,
  `["4"]` (`No`) declined at once. Single-question choice list: `["2"]` answered `Blue` at once. No `enter`
  is needed, so `option` stays `send_keys [String(n)]`. `["enter"]` on a permission prompt submits the
  highlighted option.
- **Type-your-own.** `send_keys ["3"]` on `3. Type something.` does not submit: it moves the marker there and
  focuses the field. `pane.send_text "Medium please"` landed in the field as typed (no bracketed paste
  needed), and `send_keys ["enter"]` submitted it (`→ Medium please`). The `freeText` sequence stands.
- **Key names.** `1`–`9`, `enter`, `esc` are accepted (also `down`, `ctrl+u`). An unknown name fails the whole
  call with `invalid_key` (`unsupported key notakey`) and nothing is written, even when valid keys precede
  it. `esc` on a choice list declines it (`User declined to answer questions`).
- **`agent.prompt`** on an `idle` or `done` session submits the text as one message, also when the box shows
  a dim suggestion (the paste replaces it). On a `blocked` session it fails with `agent_blocked` and nothing
  is sent.
- **Success shapes** (raw socket, one JSON line): `agent.send_keys` and `pane.send_text` →
  `{"id":"…","result":{"type":"ok"}}`; `agent.prompt` → `{"id":"…","result":{"type":"agent_prompted",
  "agent":{…AgentInfo, agent_status, pane_id, terminal_id…}}}`. Errors →
  `{"id":"…","error":{"code":"agent_blocked"|"invalid_key"|"agent_not_idle"|…,"message":"…"}}`. The CLI
  prints the same envelope for `agent send-keys`/`agent prompt` and prints nothing for `pane send-text`.

No send sequence and no confirm rule changed. Every `Yes…` option seen (`Yes, and always allow access…`,
`Yes, and switch to auto mode…`, `Yes, and switch to accept edits…`) is approving under rule 7.

## Allow-list change

- `ALLOWED_METHODS` becomes `READ_METHODS` (the same 6). A new `REPLY_METHODS` holds exactly
  `agent.prompt`, `agent.send_keys`, `pane.send_text`.
- `HerdrClient.request` keeps checking `READ_METHODS` only, so no existing route can send input.
- A separate `ReplySender` (new module) has one typed function per method; it checks `REPLY_METHODS`, builds
  the params itself (no pass-through objects) and is constructed only in `main.ts` and handed only to the reply
  route. Keys are checked against a closed list `1`–`9`, `enter`, `esc` **(my call: also `up`/`down` only if
  the builder finds digits don't select in Claude Code)**.
- Tests: every one of the 109 schema methods is tried on both paths; exactly 6 pass `request`, exactly 3 pass
  `ReplySender`, none pass both. `server.stop`, `pane.close`, `agent.start`, `pane.run`, `pane.send_keys`,
  `pane.send_input`, `agent.focus`, … are named explicitly. e2e: the fake Herdr records every method; a test
  drives each reply kind and asserts only these 9 methods were ever received.

## API

- `GET /api/sessions/:paneId/output` gains a `prompt` field (one read serves both):
  `{kind: 'permission', fingerprint, tool, request, question, options: [{n, label, description, approving}]}`,
  `{kind: 'choice', fingerprint, header?, question, options, freeTextOption?}`,
  `{kind: 'idle', fingerprint}`, `{kind: 'unrecognized', fingerprint}`, or `{kind: 'none'}` while working.
- `POST /api/sessions/:paneId/reply`, JSON body ≤ 8 KB:
  `{replyId, fingerprint, action}` where `action` is `{type: 'option', n}`, `{type: 'freeText', text}` (choice
  type-your-own: select that option's number, `pane.send_text`, then `enter`), `{type: 'prompt', text}`
  (idle), `{type: 'keys', keys}` or `{type: 'text', text}` (fallback; text is sent without Enter).
- Text: 1–4000 chars after trimming; no control characters; newlines allowed only for `prompt`
  **(my call: a newline typed into a dialog may submit it early)**.
- Responses: `200 {sent}`; `409 {error: 'prompt_changed', prompt}` with the fresh prompt;
  `409 {error: 'not_waiting'}` (status is `working`); `400` bad body or action not valid for the prompt kind
  (e.g. `option 4` of 3); `403` token/Origin/header failure; `404 session_closed`; `503 herdr_unreachable`;
  `502 herdr_error` (with Herdr's code, e.g. `agent_blocked`); `415` non-JSON.
- The server accepts `POST` on this route only; every other non-GET still gets `405`.

## Security model

Threat: another site open in the same browser forging a POST to `127.0.0.1:4321`, or framing Meerkat to trick a
tap (clickjacking).

1. **Per-launch secret.** At start the server makes 32 random bytes (`crypto.randomBytes`) and writes them into
   the served `index.html` as `<meta name="meerkat-token">`. The page sends it as `X-Meerkat-Token`. The server
   compares with `timingSafeEqual`. Never logged, never in a URL, new on every restart (the page reloads to get
   it after a 403).
2. **Why a cross-origin page can't send it.** It can't read the token: `index.html` has no CORS headers, so
   `fetch` from another origin gets an opaque response, and DNS rebinding is stopped by the existing Host check
   (421). And it can't send the header: a custom header or `Content-Type: application/json` makes the request
   non-simple, so the browser sends an `OPTIONS` preflight first; Meerkat answers it with `405` and no
   `Access-Control-Allow-*`, so the browser never sends the POST. HTML forms can't set custom headers at all.
3. **Origin check as a second lock.** The POST must carry `Origin: http://localhost:<port>` or
   `http://127.0.0.1:<port>` matching the Host, and `Sec-Fetch-Site: same-origin` when present. Missing
   Origin is refused.
4. **No framing.** Every HTML response gets `Content-Security-Policy: frame-ancestors 'none'` and
   `X-Frame-Options: DENY`, so no page can overlay Meerkat's Yes button.
5. **Local processes** can call the endpoint with the token only if they can read the page, which they can, but
   any local process can already talk to Herdr's socket directly, so this adds no new reach.

Tests: missing/wrong token 403; foreign or missing Origin 403; `OPTIONS` gets 405 with no CORS headers; form
content types 415; the frame headers on `/`; the token differs between two server instances.

## Race safety and idempotency

- **Fingerprint.** `sha256` over `paneId`, the agent's `terminal_id` (from the snapshot, so another agent in the
  same pane changes it), the card's **status epoch**, the prompt kind, and the normalized prompt block (rule to
  footer, excluding spinner, timer and status-bar lines). For `unrecognized`, the last 40 sanitized lines
  without those volatile lines.
- **Status epoch (my call).** The board keeps a per-pane counter that goes up on every status change Meerkat
  sees. A session that works and comes back to idle, or asks the same `npm test` permission twice, gets a new
  epoch, so an answer meant for the earlier screen is refused even when the text looks identical. The epoch
  goes to the browser on the card and in the `prompt` field.
- **Re-check before sending.** The reply route takes a per-pane lock, re-reads the pane, recognizes again,
  recomputes the fingerprint, and sends only if it equals the one in the request and the action fits the
  fresh prompt. Otherwise `409 prompt_changed` and the UI swaps in the new prompt. For `prompt` (idle) the
  status must also still be `idle` or `done`; `agent.prompt` itself refuses `blocked`.
- **Right session.** Target is the pane id from the URL, validated by the existing regex and matched against a
  card on the board with the same `terminal_id`. `agent.*` calls use the pane id as target.
- **Double taps.** `replyId` is a client UUID. The server remembers results for the last 5 minutes per pane
  and returns the stored result for a repeated id without sending. A different id on the same screen fails the
  fingerprint once the first answer changed the screen. The UI disables buttons while a request is in flight.
- Multi-step sends (`freeText`: number, text, enter) stop at the first error and report how far they got.

## Visibility after answering

- The card gets `lastReply: {summary, at}` (e.g. `You answered "Yes" from Meerkat · 8s ago`), kept in memory
  until the session's next reply-able prompt or 10 minutes **(builder's call within 5–15)**. Summaries never
  include free text beyond 80 chars.
- After a send, the pane is re-read at once so card-progress's sentence updates without waiting for the 10 s
  tick. The orchestrator sees the answer in the session output (Claude echoes the choice / the `❯` message),
  and the card shows it was answered from Meerkat.

## UI sketch

```
┌ Needs attention ─────────────┐   drawer (existing) ───────────────────────────
│ meerkat-audit   blocked 2m   │   meerkat-audit · blocked
│ "Plan ready, which branch?"  │   ┌ Permission: Bash command ────────────────┐
│ [Reply]                      │   │ npm test -- --run src/server              │
└──────────────────────────────┘   │ Run the server unit tests                 │
                                   └───────────────────────────────────────────┘
                                   Do you want to proceed?
                                   [Yes…] [Yes, and don't ask again…] [No…]
                                   ── after [Yes…] ─────────────────────────────
                                   Send "Yes" to meerkat-audit? It will run the
                                   command above.          [Cancel] [Send Yes]
                                   ── output (last 40 lines) ▾ ────────────────
```

- Choice: question, one button per option with its description; the type-your-own option opens a text box with
  Send. Idle: text box + Send (`⌘↩`). Unrecognized: output, text box (sends without Enter), keypad
  `1 2 3 4 5 6 7 8 9 Enter Esc`, and a line "Meerkat couldn't read this prompt; check the output first."
- **Keypad confirm (my call).** On an unrecognized screen whose status is `blocked`, every digit and `Enter`
  goes through the confirm panel ("This screen may be asking for permission; check the output above"),
  because it could be a permission prompt Meerkat failed to read. `Esc` and typed text don't need it.
- **Draft typed in the terminal (my call).** When an idle prompt box holds a draft, the text box and `Enter`
  are hidden (only the output and `Esc` show), so Meerkat never appends to or submits text it didn't write.
- Free text starting with `!` or `/` is sent as typed (it is the user's own command); the Send button reads
  "Send as command" so it isn't a surprise **(my call)**.
- Confirm is an in-page panel, never `window.confirm`. Focus starts on Cancel. Errors show inline (`The prompt
  changed, here is the new one`).
- Cards whose status is `blocked`, `idle` or `done` show a `Reply` label; the card is already a button that
  opens the drawer, so the reply panel lives in the drawer above the output **(my call: no nested button)**.
  Working sessions show no reply controls.

## Failure modes

| Case | Behaviour |
|---|---|
| Prompt changed / answered in the terminal | 409, new prompt shown, nothing sent |
| Session closed between read and tap | 404, drawer says "Session closed" (existing) |
| Herdr down | 503, reply controls disabled with the disconnected banner |
| Herdr rejects keys or `agent_blocked` | 502 with Herdr's code shown; nothing retried |
| Claude Code UI changes format | screens fall to `unrecognized` → keypad; parser tests fail on new fixtures |
| Meerkat restarted (new token) | 403 → page reloads once to pick up the new token |
| Status says idle but the screen shows a spinner (seen live) | recognizer sees no empty prompt box → `unrecognized` |

## Test strategy (red/green, no new dependencies)

- Unit: `recognize` against captured fixtures (each kind, long commands, near-misses: prose numbered lists,
  missing footer, gaps in numbering, two `❯`, multi-select, tabbed form, draft text in the prompt box);
  fingerprint stability (spinner/timer changes don't change it; option or command changes do); allow-list
  split; `ReplySender` param building and key vocabulary; token/Origin/preflight/frame headers; reply route
  (each status code, lock, replay of `replyId`, fresh read before send).
- Component: each panel, confirm flow (Yes never sent without confirm; Cancel sends nothing), disabled
  while in flight, 409 swap, `lastReply` on the card.
- e2e (fake Herdr): extend the fake to serve the three input methods, record them, and change the screen after
  a send; scenarios per kind, double-click sends once, changed-prompt 409, cross-origin page on a second test
  port cannot trigger a send, and the 9-method assertion.

## Left to the builder

- **Capture real fixtures first.** No dialog was on screen during design. Get one permission prompt, one
  single-question choice list (with descriptions and Type something), a multi-select, and a tabbed form from
  the scratch session below, via `agent.read`; strip any session content; check each with
  `herdr agent explain --file <fixture> --agent claude` reads as `blocked`. **Done in Task 0**: see
  `test-support/screens/` and the samples above.
- **Verify key behaviour in the scratch session:** whether a digit alone selects and submits in both dialog
  kinds, the exact key names Herdr accepts (`enter`, digits), and whether `pane.send_text` into the
  type-your-own field needs bracketed paste. **Done in Task 0**: see "Verified in the scratch session".

## User's answers to the builder check (2026-11-22)

1. **Key tests.** The builder may start **one** throwaway Claude session of its own (`herdr agent start` in a
   new workspace whose cwd is an empty temp folder it creates), trigger dialogs there, and send test input
   **only to that session**. Never to any other session. Close it when done and report its id.
2. **When real screens differ from this doc.** The builder may adjust recognition rules on its own as long as
   everything still falls back safely. If **what gets sent** (key or text sequences) or **the confirm rules**
   change, the builder stops and tells the user before building on it.
- Exact CSS, copy, the `lastReply` duration within 5–15 min, the 120-line read size if fixtures need more.
- **Order.** Card-progress is merged (`7b3e76b`); this branch is rebased on it and reuses its 120-line reader
  and poller for the after-send re-read.
- **Gate after fixtures.** Fixture capture and the key checks are a first phase. Recognition-rule changes
  that still fail safe are written into this doc and the build goes on. A change to a send sequence or to the
  confirm rules stops the build for the user (answer 2 above).
