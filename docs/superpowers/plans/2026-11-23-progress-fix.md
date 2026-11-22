# Card Progress on Busy Panes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Board cards show the latest `⏺` sentence for `working` and `blocked` sessions instead of keeping an older one.

**Architecture:** The card-progress reader asks Herdr for `recent_unwrapped` with `lines: 120`. Herdr 0.9.5 refuses that with `agent_not_idle` when the pane is `working` or `blocked` and `lines` is larger than the viewport. `read-prompt.ts` already handles this case: it retries once with `source: 'visible'`. This plan moves that read-and-retry into a shared module that both readers use, and makes the progress reader take a `visible` read as valid only when it has a `⏺` block.

**Tech Stack:** TypeScript, Node 24, Vitest, Playwright, the fake Herdr socket server in `test-support/fake-herdr.ts`.

**Spec:** the bug report in the session, plus the "Read size while blocked" section of `docs/superpowers/specs/2026-11-22-reply-design.md`, which recorded this limit and said card-progress "should use the same fallback".

## Root cause (verified 2026-11-23, herdr 0.9.5, scratch Claude pane with 28 viewport rows)

`readProgress` (`src/server/progress.ts:91-102`) always sends `agent.read {source: 'recent_unwrapped', lines: 120}`. Herdr can only capture alternate-screen history by scrolling, which it does only while the agent is idle. So when the agent is `working` or `blocked` and `lines > viewport_rows`, it returns `agent_not_idle` ("cannot read 120 lines while … is blocked: its alternate-screen history can only be captured by scrolling while idle"). The measured results were: 28 lines ok and 29 fail; `visible` ok; in `done`/`idle`, 120 lines ok, returning only the 29 screen rows. `progress-poller.ts` turns the error into `null` and skips delivery, so `applyProgress` never runs and the card keeps the last sentence it read while the pane was idle or done. `working` panes are hit the same way as `blocked` ones, and because the poller re-reads `working` panes every 10 s, every one of those reads fails today.

## Global Constraints

- No code comments; no lint or type rule disabled anywhere.
- Herdr methods: only `ALLOWED_METHODS`; progress reads stay `agent.read` with `format: 'text'`, `strip_ansi: true`.
- The first read stays `source: 'recent_unwrapped'`, `lines: 120`. The only retry is one `source: 'visible'` read, and only on error code `agent_not_idle`.
- `MAX_PROGRESS_CHARS` (280) and the extraction rules in `extractProgress` are unchanged.
- No secrets, emails or project IDs in the repo. Commits, PR title and description in English.

## Behaviour by pane state

| Pane state | Read sequence | Card result |
|---|---|---|
| idle / done | `recent_unwrapped` 120 → ok | latest sentence (unchanged behaviour) |
| working / blocked, viewport ≥ 120 rows | `recent_unwrapped` 120 → ok | latest sentence |
| working / blocked, viewport < 120 rows | 120 → `agent_not_idle`, then `visible` → ok | latest `⏺` sentence on screen; if the screen has no `⏺` block, `null` (previous sentence kept) |
| pane closed | `agent_not_found` → `gone` | `null`, previous sentence kept (unchanged) |
| any other error, or the `visible` retry fails | error thrown, poller turns it into `null` | previous sentence kept, with its existing "updated X ago" age |

The `visible` read only accepts `⏺` blocks because, on a blocked pane, the line fallback in `extractProgress` would pick dialog chrome such as `Enter to select · ↑/↓ to navigate · Esc to cancel` or an option label. Showing an older but real sentence is better than that.

How the board behaves when a read fails: nothing new is sent. The card keeps its last `progress.text`, and `since` stays the time that text was first seen, so "updated X ago" keeps growing. The next tick (10 s for `working`) or the next status change reads again. This plan does not add a stale marker (see Out of scope).

## Review Focus

1. A tall dialog pushes the last `⏺` sentence above the viewport, so the `visible` read has no `⏺` block: the card must keep the old sentence and must not show the dialog footer (Task 2, `returns null when the visible screen has no ⏺ block`).
2. The viewport is exactly 120 rows: the first read succeeds and no retry is sent (Task 2, `does not retry when the pane is tall enough`).
3. The `visible` retry fails too: the error is thrown and no third read is sent (Task 2, `throws when the visible retry fails too`).
4. A `blocked` → answered → `working` transition with a short viewport: the card moves to the new sentence on the next read (Task 3 supervisor test).
5. The prompt and output reader must behave exactly as it does today after the refactor (Task 1 keeps `read-prompt.test.ts` unchanged and green).

---

### Task 0: Fake Herdr models the busy-viewport limit (already written during debugging, uncommitted)

**Files:**
- Modify: `test-support/fake-herdr.ts` (adds `setBusyViewport(paneId: string, rows: number | null): void`)
- Test: `src/server/herdr/fake-herdr.test.ts` (`refuses recent reads longer than a busy pane viewport, like Herdr`)
- Test: `src/server/progress.test.ts` (`reads the latest sentence of a busy pane shorter than the requested lines`, currently RED)

**Interfaces:**
- Produces: `fake.setBusyViewport(paneId, rows)`. While it is set, an `agent.read` whose `source` is not `visible` and whose `lines` is missing or `> rows` answers `{error: {code: 'agent_not_idle', message: 'cannot read <n> lines while <pane> is blocked: …'}}`. `null` clears it.

- [ ] **Step 1:** Run `npx vitest run src/server/herdr/fake-herdr.test.ts` → PASS; `npx vitest run src/server/progress.test.ts` → exactly 1 FAIL, `HerdrProtocolError: cannot read 120 lines while w1:p1 is blocked`.
- [ ] **Step 2: Commit** the fake, its test and the red progress test together with the Task 2 fix (do not commit a red suite on its own); go on to Task 1.

### Task 1: Shared screen reader

**Files:**
- Create: `src/server/read-screen.ts`
- Create: `src/server/read-screen.test.ts`
- Modify: `src/server/read-prompt.ts:9,24-39` (delete `readOnce`/`readScreen`; import from the new module)

**Interfaces:**
- Produces:
  - `export const RECENT_LINES = 120`
  - `export type ScreenRead = { kind: 'gone' } | { kind: 'ok'; text: string; truncated: boolean; source: 'recent_unwrapped' | 'visible' }`
  - `export async function readScreen(client: HerdrClient, target: string): Promise<ScreenRead>`: sends `{target, format: 'text', strip_ansi: true, source: 'recent_unwrapped', lines: RECENT_LINES}`; on `HerdrProtocolError` with code `agent_not_idle`, sends one `{target, format: 'text', strip_ansi: true, source: 'visible'}`; rethrows every other error and any error from the retry.

- [ ] **Step 1: Write failing tests** in `read-screen.test.ts`, against `startFakeHerdr`:
  - `reads 120 recent lines from an idle pane` → result `{kind: 'ok', text, source: 'recent_unwrapped'}`; `fake.received` has exactly one `agent.read` with `{target: 'w1:p1', source: 'recent_unwrapped', lines: 120, format: 'text', strip_ansi: true}`.
  - `falls back to the visible screen on a busy pane shorter than 120 rows` → `setBusyViewport('w1:p1', 28)`; result `source: 'visible'`; second request params `{target: 'w1:p1', source: 'visible', format: 'text', strip_ansi: true}`.
  - `does not retry when the pane is tall enough` → `setBusyViewport('w1:p1', 120)`; one request; `source: 'recent_unwrapped'`.
  - `returns gone for a closed pane` → no read set → `{kind: 'gone'}`, one request.
- [ ] **Step 2:** `npx vitest run src/server/read-screen.test.ts` → FAIL (module not found).
- [ ] **Step 3:** Implement `read-screen.ts`. Change `read-prompt.ts` to call `readScreen` and drop `RECOGNITION_LINES` in favour of `RECENT_LINES`. `readPrompt` ignores `source`.
- [ ] **Step 4:** `npx vitest run src/server/read-screen.test.ts src/server/read-prompt.test.ts src/server/http.test.ts` → PASS, with `read-prompt.test.ts` unchanged.
- [ ] **Step 5: Commit** `Share the recent-then-visible screen read`.

### Task 2: Progress reader uses the shared read

**Files:**
- Modify: `src/server/progress.ts:80-102`
- Test: `src/server/progress.test.ts`

**Interfaces:**
- Consumes: `readScreen`, `ScreenRead` from Task 1.
- Produces: `extractProgress(text: string, opts?: { markerOnly?: boolean }): string | null`. With `markerOnly: true` it returns `null` when there are no `⏺` blocks instead of using the line fallback. `readProgress(client, paneId)` keeps its signature.

- [ ] **Step 1: Write failing tests:**
  - (from Task 0) `reads the latest sentence of a busy pane shorter than the requested lines` → `'Waiting on your answer.'`.
  - `returns null when the visible screen has no ⏺ block` → busy viewport 28; read text `'Which color do you pick?\n❯ 1. Red\n  2. Blue\nEnter to select · ↑/↓ to navigate · Esc to cancel'` → `null`.
  - `keeps the line fallback for idle panes` → no busy viewport; read text `'npm test\nall 12 passed'` → `'all 12 passed'`.
  - `throws when the visible retry fails too` → add `fake.setVisibleReadError(paneId: string, error: {code: string; message: string} | null): void` to `test-support/fake-herdr.ts` (answers that error to `source: 'visible'` reads of that pane; covered by a fake-herdr.test.ts case). Busy viewport 28 + visible error `{code: 'agent_not_idle', message: 'x'}` → `rejects.toMatchObject({code: 'agent_not_idle'})` and exactly 2 `agent.read` requests.
  - `throws on other errors without retrying` → a stub `HerdrClient` whose `request` rejects with `new HerdrProtocolError('internal', 'x')` → `rejects.toMatchObject({code: 'internal'})`, `request` called once.
  - `extractProgress(..., {markerOnly: true})` unit cases: `'plain line'` → `null`; `'⏺ Done.\nEnter to select'` → `'Done.'`.
- [ ] **Step 2:** `npx vitest run src/server/progress.test.ts` → the new cases FAIL.
- [ ] **Step 3:** `readProgress` calls `readScreen`; `gone` → `null`; otherwise `extractProgress(sanitizeOutput(read.text).text, {markerOnly: read.source === 'visible'})`.
- [ ] **Step 4:** `npx vitest run src/server` → PASS.
- [ ] **Step 5: Commit** (with the Task 0 files) `Read card progress from the visible screen on busy panes`.

### Task 3: Board keeps up with busy sessions (integration)

**Files:**
- Test: `src/server/supervisor.test.ts` (next to `a working card's progress updates on the interval`, using `PROGRESS`)
- Test: `e2e/board.spec.ts` (inside `with progress reads`)

**Interfaces:**
- Consumes: `fake.setBusyViewport`, `fake.setVisibleReadError` from Tasks 0 and 2.

- [ ] **Step 1: Write the tests:**
  - supervisor `a blocked card shows its newest sentence on a short pane`: pane `wJ:p1` idle with `'⏺ Halfway there.'` → progress `Halfway there.`; then `setBusyViewport('wJ:p1', 28)`, `setRead('wJ:p1', '⏺ Need your OK to proceed.\n…dialog…')`, `pushStatus('wJ:p1', 'blocked')` → progress text becomes `Need your OK to proceed.`.
  - supervisor `a working card on a short pane updates on the interval`: same, but status `working`, and the text changes once more between ticks → the card follows both changes.
  - supervisor `a failed busy read keeps the previous sentence and its age`: progress `Halfway there.` with `since = t0`; busy viewport 28 plus a visible read error; `pushStatus('wJ:p1', 'blocked')`; after two intervals the progress is still `{text: 'Halfway there.', since: t0}`, and the card's status is `blocked`.
  - e2e `shows the newest sentence for a blocked session on a short pane`: initial read `'⏺ Halfway there.'` → card shows it; `setBusyViewport` 28, `setRead` new text, `pushStatus` blocked → the card is in the Blocked column and shows `Need your OK to proceed.`.
- [ ] **Step 2:** Run them on the Task 2 code: `npx vitest run src/server/supervisor.test.ts` and `npm run test:e2e` → PASS. To confirm they guard the bug, temporarily revert `progress.ts` with `git stash push -m progress-fix-check -- src/server/progress.ts` and check that the blocked and working tests FAIL. Then restore with `git stash apply <sha>` and drop that entry by its tag.
- [ ] **Step 3: Commit** `Cover busy-pane progress on the board`.

### Task 4: Verify, real-Herdr check, PR

- [ ] **Step 1:** `npm test && npm run test:e2e && npm run lint && npm run typecheck && npm run format:check` → all exit 0.
- [ ] **Step 2:** Real-Herdr check on a scratch pane created and closed by the implementer, never another session: `herdr pane split --current --direction down --no-focus`, start a named claude agent, prompt it to write a sentence and then ask an AskUserQuestion. Run `npm run build && MEERKAT_PORT=43299 node dist/server/main.js` from this worktree (default socket), and check that the `/api/events` stream's card for the scratch pane carries the new `progress.text` while it is blocked and while it is working. Stop the server. Answer the dialog, wait for done, and close the pane.
- [ ] **Step 3:** Push `fix/progress-stale`; `gh pr create --base main` with an English title `Fix stale card progress on working and blocked panes`, a body with the root cause paragraph, the state table and the test list, ending with the Claude Code attribution line. Do not merge; no PR comments.

## Out of scope

- A visible "stale" marker on cards when a read fails (a UI feature; ask first if wanted).
- Changing the poll cadence or reading `blocked` panes on an interval (today they are read only on status change and refresh).
- Non-Claude agents' busy screens (no regression: today these reads fail outright).
