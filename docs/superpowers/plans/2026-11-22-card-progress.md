# Card Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each board card shows the session's latest Claude Code update sentence and how long ago it changed.

**Architecture:** A pure parser (`src/server/progress.ts`) turns `agent.read` text into one sentence. A
progress poller (`src/server/progress-poller.ts`) decides when to read each pane: every 10 s while working,
right away on first sight or status change, one read at a time. The supervisor wires the poller to the board
reducer, which stores `progress` on each card and keeps its timestamp unless the text changes. `CardView`
renders it.

**Tech Stack:** TypeScript, Node 24 `node:net`, React 19, Vitest (node + jsdom), Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-22-card-progress-design.md`

## Global Constraints

- Herdr methods: only the existing `ALLOWED_METHODS`; progress uses `agent.read` with `source: 'recent_unwrapped'`, `format: 'text'`, `strip_ansi: true`, `lines: 120`.
- Working re-read interval: 10 000 ms (default of `progressIntervalMs`).
- Sentence cap: 280 characters including the trailing `…`, cut on a code point boundary.
- Card text: `updated {formatElapsed(...)} ago`, e.g. `updated 12s ago`, `updated ≥ 3m ago`.
- Card sentence clamped to 2 lines with CSS (`line-clamp: 2`), no JS truncation in the UI.
- No new dependencies. No code comments. No lint/type suppressions. Don't touch `.github/` or CI-only scripts.
- Read-only, 127.0.0.1, GET only, no CORS: no change to `http.ts` routing.
- Your own runs and e2e use ports other than 4321 (the e2e default 43219 is fine).

## Review Focus

- A long tool run pushes every text block out of the 120-line window (only tool-call blocks remain): the card keeps its previous sentence and age, never shows a tool line or blanks. Test: Task 1 `extractProgress` returns `null` + Task 3 poller doesn't call `onProgress` for `null`.
- Real Claude Code chrome uses U+00A0 (`❯ `, `⎿ `) and the status bar/spinner lines: none of them ever becomes the sentence. Test: Task 1 fixture tests.
- A multi-paragraph or very long final message (lists, emoji, CJK): only the first paragraph, capped at 280 chars with `…`, never splitting a surrogate pair. Test: Task 1.
- A pane closes or Herdr drops while a read is in flight: no crash, no card resurrected for a removed pane, no reads while disconnected, and everything re-read after reconnect. Test: Task 3 and Task 4.
- 60 working sessions: never more than one read in flight, a slow read doesn't let ticks pile up duplicate reads of the same pane. Test: Task 3.

---

### Task 1: Progress parser

**Files:**
- Create: `src/server/progress.ts`
- Test: `src/server/progress.test.ts`

**Interfaces:**
- Produces: `extractProgress(text: string): string | null` and `MAX_PROGRESS_CHARS = 280`, both exported from `src/server/progress.ts`.

Fixtures copy the structure of real Claude Code 2.x output read from a live pane on 2026-11-22 (marker
characters, U+00A0, indentation, chrome lines), with neutral wording. Build them as `[...].join('\n')` with
` ` written as an escape. Base fixture `CLAUDE_SCREEN`:

```ts
const NBSP = ' '
const CLAUDE_SCREEN = [
  '⏺ I will check the parser first.',
  '',
  '⏺ Skill(superpowers:writing-plans)',
  `  ⎿ ${NBSP}Successfully loaded skill`,
  '',
  '⏺ Parser tests pass; moving on to the poller and its cadence tests.',
  '',
  '⏺ Reading the pane output via read-only agent.read',
  `  ⎿  $ printf '%s\\n' '{"id":"probe-1"}' | nc -U -w 3 "$SOCK"`,
  '',
  '· Flummoxing… (44s · ↓ 2.3k tokens)',
  '',
  '─'.repeat(80),
  `❯${NBSP}`,
  '─'.repeat(80),
  '  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← 1 agent',
].join('\n')
```

- [ ] **Step 1: Write the failing tests** in `src/server/progress.test.ts`, one `it` each:
  - `picks the last text block, skipping a described Bash call followed by ⎿`: `extractProgress(CLAUDE_SCREEN)` → `'Parser tests pass; moving on to the poller and its cadence tests.'`
  - `skips Name( tool calls`: for each of `Bash(npm test)`, `Agent(review)`, `Read(src/a.ts)`, `Update(src/a.ts)`, `Write(docs/x.md)`, `Skill(x)`, the input `'⏺ Done with setup.\n\n⏺ ' + call` → `'Done with setup.'`; also a call with no `⎿` after it (still running).
  - `joins continuation lines of a block`: `'⏺ First part of the\n  sentence continues\n  here.\n\n  Second paragraph.'` → `'First part of the sentence continues here.'`
  - `accepts NBSP after the marker`: `` `⏺${NBSP}Working on it.` `` → `'Working on it.'`
  - `returns null when every block is a tool call`: `'⏺ Bash(ls)\n  ⎿  a\n⏺ Read(b)\n  ⎿  Read 3 lines'` → `null`
  - `falls back to the last non-chrome line without ⏺ blocks`: `'building...\ncompiled 12 files\n\n' + '─'.repeat(40) + '\n❯ npm run dev\n  ⏵⏵ auto mode on (shift+tab to cycle)\n✻ Churned for 4s · done 20:39'` → `'compiled 12 files'`
  - `never returns prompt lines`: inputs `'❯ suggested command'`, `` `❯${NBSP}` ``, `'❯'`, `'╭────╮\n│ > hi │\n╰────╯'` → each `null`
  - `ignores spinner lines`: `'step one\n✢ Thinking… (3s)\n⠋ Loading'` → `'step one'`
  - `returns null for empty output`: `''` and `'\n\n  \n'` → `null`
  - `caps long text at 280 characters`: `'⏺ ' + 'a'.repeat(400)` → length 280, ends with `'…'`; `'⏺ ' + '😀'.repeat(300)` → result has no lone surrogate (`/[\ud800-\udbff](?![\udc00-\udfff])/` doesn't match) and ends with `'…'`.
  - `keeps a list in the first paragraph`: `'⏺ Done:\n  - parser\n  - poller'` → `'Done: - parser - poller'`

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/server/progress.test.ts`
Expected: FAIL, cannot resolve `./progress.js`.

- [ ] **Step 3: Implement `extractProgress(text: string): string | null`**

Normalize U+00A0 to a space per line and `trimEnd` before classifying. Block rules, tool-call rules (head
matching `/^[A-Za-z][\w-]*\(/` or followed by a `⎿` line) and chrome rules are in the spec, sections
"Extracting the update sentence" 1–6. Chrome: only box-drawing characters U+2500–U+257F plus spaces, starting
with `│`/`╭`/`╰`, starting with `❯`, starting (after trim) with `⏵`, or starting with a spinner glyph from
`·✢✳✶✻✽` or the braille block U+2800–U+28FF followed by a space. Collapse internal whitespace to single
spaces. Cap with `Array.from` (code points): if longer than 280, keep 279 code points then `'…'`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/server/progress.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/progress.ts src/server/progress.test.ts
git commit -m "feat: extract latest update sentence from pane output"
```

### Task 2: Progress on cards in the board reducer

**Files:**
- Modify: `src/shared/types.ts` (`Card`)
- Modify: `src/server/board.ts` (`boardFromSnapshot`, new `applyProgress`)
- Modify: `src/web/Board.test.tsx`, `src/web/OutputDrawer.test.tsx`, `src/server/http.test.ts` (their `Card` literals get `progress: null`), and the existing full-card `toEqual` expectations in `src/server/board.test.ts`
- Test: `src/server/board.test.ts`

**Interfaces:**
- Produces in `src/shared/types.ts`:
  ```ts
  export interface Progress { text: string; since: number; sinceIsLowerBound: boolean }
  ```
  and `Card.progress: Progress | null`.
- Produces in `src/server/board.ts`: `applyProgress(state: BoardState, paneId: string, text: string, now: number): BoardState`.

- [ ] **Step 1: Write the failing tests** in `src/server/board.test.ts`:
  - `new cards start with no progress`: `boardFromSnapshot(null, snap, 1000, HOME)` card has `progress: null`.
  - `first progress is a lower bound`: `applyProgress(state, 'w1:p1', 'hello', 2000)` → `{ text: 'hello', since: 2000, sinceIsLowerBound: true }`.
  - `same text keeps since and returns the same state object`: apply `'hello'` at 2000 then at 9000 → `since` 2000 and `toBe` the previous state.
  - `changed text resets since exactly`: `'hello'` at 2000, `'world'` at 5000 → `{ text: 'world', since: 5000, sinceIsLowerBound: false }`.
  - `unknown pane is ignored`: returns the same state object.
  - `snapshot keeps progress of existing cards and drops removed ones`: progress survives `boardFromSnapshot(prev, …)` and `applyStatusEvent`; a pane missing from the next snapshot is gone.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/server/board.test.ts`
Expected: FAIL, `applyProgress` is not exported / `progress` missing.

- [ ] **Step 3: Implement** the type, `progress: previous?.progress ?? null` in `boardFromSnapshot`, and `applyProgress`. Add `progress: null` to the `Card` literals in `src/web/Board.test.tsx`, `src/web/OutputDrawer.test.tsx`, `src/server/http.test.ts` and to the existing full-card expectations in `src/server/board.test.ts`, so typecheck and those tests stay green.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/server/board.ts src/server/board.test.ts src/web/Board.test.tsx src/web/OutputDrawer.test.tsx src/server/http.test.ts
git commit -m "feat: keep per-card progress with change timestamp"
```

### Task 3: Progress poller (cadence)

**Files:**
- Create: `src/server/progress-poller.ts`
- Test: `src/server/progress-poller.test.ts`

**Interfaces:**
- Consumes: `AgentStatus` from `src/shared/types.ts`.
- Produces:
  ```ts
  export interface PolledPane { paneId: string; status: AgentStatus }
  export interface ProgressPoller {
    sync(panes: readonly PolledPane[]): void
    stop(): void
  }
  export interface ProgressPollerOptions {
    read: (paneId: string) => Promise<string | null>
    onProgress: (paneId: string, text: string) => void
    intervalMs?: number
  }
  export function createProgressPoller(opts: ProgressPollerOptions): ProgressPoller
  ```

Behaviour: `sync` replaces the known pane set. A pane that is new or whose status differs from the last
`sync` is queued now. A repeating timer every `intervalMs` (default 10 000) queues every known `working`
pane. The queue is an insertion-ordered set (a pane queued twice is read once), drained one read at a time.
`read` rejecting or returning `null` → no callback. A result for a pane no longer known when the read
settles → dropped. `stop` clears the timer and the queue; nothing is called after `stop`.

- [ ] **Step 1: Write the failing tests** with `vi.useFakeTimers()` and a controllable `read` (a map of pane → deferred promise, recording call order):
  - `reads every pane on first sync`: sync `[a working, b idle]` → `read` called for `a` then `b` (second only after first settles); `onProgress` receives both texts.
  - `re-reads working panes every 10 s, not idle ones`: after the first reads, `vi.advanceTimersByTime(10_000)` → one more read of `a`, none of `b`; after another 10 000 → `a` again.
  - `reads a pane when its status changes`: sync `b` as `done` → `b` read immediately; syncing the same statuses again → no read.
  - `never has two reads in flight`: 60 working panes, each read held pending; at most one pending at any moment; after all settle, exactly 60 reads.
  - `does not pile up reads during a slow read`: `a` read pending across three ticks → after it settles, `a` read at most once more.
  - `skips null and failed reads`: `read` resolving `null` and rejecting → `onProgress` not called; the next pane is still read.
  - `drops results for panes removed while reading`: start read of `a`, `sync([])`, resolve → `onProgress` not called; no further reads.
  - `stop halts everything`: `stop()` with a read pending and timers armed → resolving it and advancing 30 s calls nothing.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/server/progress-poller.test.ts`
Expected: FAIL, cannot resolve `./progress-poller.js`.

- [ ] **Step 3: Implement `createProgressPoller`** as described above.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/server/progress-poller.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/progress-poller.ts src/server/progress-poller.test.ts
git commit -m "feat: poll pane progress on status change and every 10s while working"
```

### Task 4: Wire progress into the supervisor

**Files:**
- Modify: `src/server/progress.ts` (add `readProgress`)
- Modify: `src/server/supervisor.ts`
- Test: `src/server/progress.test.ts`, `src/server/supervisor.test.ts`

**Interfaces:**
- Consumes: `extractProgress` (Task 1), `applyProgress` (Task 2), `createProgressPoller` (Task 3), `parseReadResponse` from `src/server/herdr/protocol.ts`, `sanitizeOutput` from `src/server/output.ts`.
- Produces: `readProgress(client: HerdrClient, paneId: string): Promise<string | null>` in `src/server/progress.ts`; `SupervisorOptions.progressIntervalMs?: number` (default 10 000).

- [ ] **Step 1: Write the failing tests**
  - In `progress.test.ts`, against `startFakeHerdr`: `readProgress sends agent.read with the pinned params` → `fake.received` has `{ method: 'agent.read', params: { target: 'w1:p1', source: 'recent_unwrapped', lines: 120, format: 'text', strip_ansi: true } }` and the result is the extracted sentence; `readProgress returns null for a closed pane` (no read set → `agent_not_found`).
  - In `supervisor.test.ts` (use `progressIntervalMs: 50` in these tests):
    - `cards get progress after the first snapshot`: fake read for `wJ:p1` = `'⏺ Halfway there.'` → eventually the card's `progress.text` is `'Halfway there.'` and `sinceIsLowerBound` is `true`.
    - `a working card's progress updates on the interval`: change the fake read to `'⏺ Almost done.'` → card text becomes `'Almost done.'` with `sinceIsLowerBound: false`, without any status event.
    - `a status change triggers a read of an idle card`: idle card, change the read, `pushStatus(pane, 'done')` → new text shows.
    - `no progress reads while Herdr is down`: stop the fake, record `count(fake, 'agent.read')`, wait several intervals → unchanged; restart → reads resume.
    - Extend `stop closes the subscription and makes no further requests` so it also has a working pane with progress reads on.
  - All existing supervisor tests still pass unchanged (only `agent.read` is added, which is allow-listed).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/server/progress.test.ts src/server/supervisor.test.ts`
Expected: the new tests FAIL; the existing ones PASS.

- [ ] **Step 3: Implement**
  - `readProgress`: request with the pinned params, `parseReadResponse`, `gone` → `null`, `extractProgress(sanitizeOutput(read.text).text)`.
  - Supervisor: create one poller with `read: (paneId) => readProgress(client, paneId)` and `onProgress: (paneId, text) => { board = applyProgress(board, paneId, text, now()); publish() }`. In `publish()`, before the unchanged-JSON early return, call `poller.sync(herdr === 'connected' ? cards : [])`, with the panes and statuses from `board.cards`. `stop()` calls `poller.stop()` before awaiting the loop.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/progress.ts src/server/progress.test.ts src/server/supervisor.ts src/server/supervisor.test.ts
git commit -m "feat: read session progress from Herdr in the supervisor"
```

### Task 5: Show progress on the card

**Files:**
- Modify: `src/web/Card.tsx`, `src/web/styles.css`, `README.md` (one line in the features list)
- Test: `src/web/Board.test.tsx`

**Interfaces:**
- Consumes: `Card.progress: Progress | null` (Task 2), `formatElapsed` from `src/web/elapsed.ts`.

- [ ] **Step 1: Write the failing tests** in `Board.test.tsx`:
  - `shows the progress sentence and its age`: `card({ progress: { text: 'Parser tests pass.', since: now - 12_000, sinceIsLowerBound: false } })` → `getByText('Parser tests pass.')` has class `card-progress`; `getByText('updated 12s ago')` exists.
  - `marks a first-seen age as a lower bound`: `sinceIsLowerBound: true`, `since: now - 180_000` → `getByText('updated ≥ 3m ago')`.
  - `shows nothing extra without progress`: `progress: null` → `queryByText(/^updated /)` is `null` and no `.card-progress` element.
  - `progress text is rendered as text, not HTML`: text `'<b>x</b>'` → visible as that literal string, no `b` element inside the card.
  - `progress age ticks with now`: rerender with `now + 60_000` → `updated 1m ago`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/web/Board.test.tsx`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement**: in `CardView`, after the title, when `card.progress !== null` render `<span className="card-progress">{text}</span>` and `<span className="card-progress-age">updated {formatElapsed(now - since, sinceIsLowerBound)} ago</span>`. CSS: `.card-progress` uses `display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; overflow-wrap: anywhere;`; `.card-progress-age` is small and muted like `.card-workspace`. README: one line under the features: cards show each session's latest update and when it changed.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/Card.tsx src/web/styles.css src/web/Board.test.tsx README.md
git commit -m "feat: show latest progress on board cards"
```

### Task 6: End-to-end against the fake Herdr

**Files:**
- Modify: `e2e/fixtures.ts` (new option `initialReads: Record<string, string>`, default `{}`, passed to `startFakeHerdr({ snapshot, reads })`)
- Modify: `e2e/board.spec.ts`

**Interfaces:**
- Consumes: `startFakeHerdr({ snapshot, reads })` and `fake.setRead`, `fake.pushStatus` from `test-support/fake-herdr.ts` (unchanged).

- [ ] **Step 1: Write the failing test** `shows progress on the card and updates it on status change`:
  - `test.use({ initialReads: { 'w3:p1': '⏺ Bash(npm test)\n  ⎿  ok\n\n⏺ Tests are green; writing the docs next.\n\n❯ ' } })` inside a `test.describe`.
  - The `working-one` card in the Working column contains `'Tests are green; writing the docs next.'` and a text matching `/updated ≥ \d+s ago/`.
  - `meerkat.fake.setRead('w3:p1', '⏺ Docs written; all checks pass.')`, `pushStatus('w3:p1', 'done')` → the card in Needs attention shows `'Docs written; all checks pass.'` and `/updated \d+s ago/` without `≥` (within 5 s).
  - The fixture's allow-list assertion still runs after the test (no change needed).

- [ ] **Step 2: Run to verify it fails**

Run: `MEERKAT_E2E_PORT=43229 npm run test:e2e -- -g "shows progress"`
Expected: FAIL, the sentence never appears (before fixture/option is in place: type error on `initialReads`).

- [ ] **Step 3: Implement** the `initialReads` option in `e2e/fixtures.ts`.

- [ ] **Step 4: Run the full e2e suite**

Run: `MEERKAT_E2E_PORT=43229 npm run test:e2e`
Expected: all tests PASS. Port 43229 is used to stay clear of the user's Meerkat on 4321; if it's taken, report the clash and pick another free port.

- [ ] **Step 5: Commit**

```bash
git add e2e/fixtures.ts e2e/board.spec.ts
git commit -m "test: e2e for progress on cards"
```

## Final verification

Run each and confirm a clean result before opening the PR:

| Check | Command | Passing output |
| --- | --- | --- |
| Unit | `npm test` | all server and web tests pass |
| Lint | `npm run lint` | no output, exit 0 |
| Format | `npm run format:check` | `All matched files use Prettier code style!` |
| Types | `npm run typecheck` | exit 0 |
| Build | `npm run build` | exit 0, `dist/` written |
| E2E | `MEERKAT_E2E_PORT=43229 npm run test:e2e` | all Playwright tests pass |
| Hygiene | `git diff origin/main --stat -- .github scripts` | empty |
