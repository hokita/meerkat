# Four Columns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the board's Needs attention column into Waiting for you (`blocked`) and Done (`done`), giving four
columns: Waiting for you, Done, Working, Idle.

**Architecture:** The server's pure board module maps each Herdr status to one of four columns and sorts them into
a `BoardView` with keys `waiting`, `done`, `working`, `idle`, sent over SSE as today. The React board renders the
four columns in that order; CSS lays them out as 4 / 2 × 2 / 1 columns by width.

**Tech Stack:** TypeScript, React 19 + Vite, Vitest + Testing Library, Playwright with the fake Herdr socket.

**Spec:** `docs/superpowers/specs/2026-11-21-meerkat-design.md`, section "Update 2026-11-23: four columns".

## Global Constraints

- Column titles, exact: `Waiting for you`, `Done`, `Working`, `Idle`, in that order.
- Status mapping: `blocked` → `waiting`; `done` → `done`; `working` → `working`; everything else → `idle`.
- `BoardView` keys: `waiting`, `done`, `working`, `idle`. The `attention` key and `Column` value go away entirely.
- Breakpoints: 4 columns at `min-width: 1100px`; 2 columns from 720 px to 1099 px; 1 column at `max-width: 719px`.
- Empty columns stay visible with their badge `0` and the text `Nothing here`.
- No code comments. Never disable lint or type rules. Red/green TDD for each change.
- Do not touch the main checkout (`~/ghq/github.com/hokita/meerkat`) or other worktrees. No input to Herdr
  sessions other than ones created for testing. No secrets, emails or project IDs in the repo.
- Done means `npm run lint`, `npm run typecheck`, `npm run format:check`, `npm test`, `npm run test:e2e` all pass.

## Review Focus

1. A card moving `blocked` → `done` (or back) must jump between Waiting for you and Done with its elapsed time
   reset, and the open reply drawer must keep showing that card (findCard looks through all four columns).
2. At a 390 px phone width the four columns stack in order with no horizontal page scroll.
3. At a 1024 px laptop width the board is a 2 × 2 grid, not four squeezed columns, and long names still wrap.
4. A reply sent from a Waiting for you card keeps its "from Meerkat" line when the card moves to Working, and
   loses it when the session reaches Done. Already pinned by `board.test.ts › replies`; the rule is per status,
   so the split does not change it.
5. A browser tab left open across the upgrade receives the new board shape while running old code; the PR
   description must tell the user to reload open Meerkat tabs once.

---

### Task 1: Server board groups four columns

**Files:**
- Modify: `src/shared/types.ts` (`Column`, `BoardView`)
- Modify: `src/server/board.ts:13-17` (`columnOf`), `src/server/board.ts:163-170` (`toView`)
- Test: `src/server/board.test.ts`
- Modify (type fallout, same meaning): `src/server/supervisor.test.ts`, `src/server/http.test.ts`,
  `src/server/reply.test.ts`, `src/server/reply-race.test.ts`, `src/web/useMeerkatStream.test.tsx`

**Interfaces:**
- Produces: `type Column = 'waiting' | 'done' | 'working' | 'idle'`;
  `interface BoardView { waiting: Card[]; done: Card[]; working: Card[]; idle: Card[] }`;
  `columnOf(status: AgentStatus): Column`; `toView(state: BoardState): BoardView`.

- [ ] **Step 1: Write the failing tests** in `src/server/board.test.ts`

Replace the `columnOf` test body:

```ts
expect(columnOf('blocked')).toBe('waiting')
expect(columnOf('done')).toBe('done')
expect(columnOf('working')).toBe('working')
expect(columnOf('idle')).toBe('idle')
expect(columnOf('unknown')).toBe('idle')
```

Rewrite `toView › groups and orders cards`: agents `b1` blocked, `b2` blocked, `d1` done, `d2` done, the same
`w1`/`w2` and `i1`–`i4` as today. Events: `b1` → done@3000 → blocked@3500, `b2` → done@2000 → blocked@2500,
`d1` → blocked@5000 → done@5200, `d2` → blocked@4800 → done@4900, then the existing `w1`/`w2` events. Assert:

```ts
expect(Object.keys(view)).toEqual(['waiting', 'done', 'working', 'idle'])
expect(view.waiting.map((c) => c.paneId)).toEqual(['b2', 'b1'])
expect(view.done.map((c) => c.paneId)).toEqual(['d2', 'd1'])
expect(view.working.map((c) => c.paneId)).toEqual(['w2', 'w1'])
expect(view.idle.map((c) => c.paneId)).toEqual(['i3', 'i4', 'i2', 'i1'])
```

Add `toView › moves a card between Waiting for you and Done`: one `blocked` card at 1000, event `done`@2000;
assert `view.waiting` is empty, `view.done[0]` has `since: 2000`; event `blocked`@3000; assert it is back in
`waiting` with `since: 3000`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/server/board.test.ts`
Expected: FAIL (`columnOf('blocked')` returns `'attention'`; `view.waiting` undefined).

- [ ] **Step 3: Implement** `Column`, `BoardView`, `columnOf`, `toView` per the Interfaces block. `toView` builds
  `{ waiting: [], done: [], working: [], idle: [] }` in that key order and sorts `waiting`, `done`, `working`
  with the existing `bySince`, `idle` with `byName`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/server/board.test.ts`
Expected: PASS.

- [ ] **Step 5: Fix the type fallout.** Run `npm run typecheck`; in each listed test file replace empty boards
  with `{ waiting: [], done: [], working: [], idle: [] }`, and replace `board.attention` with `board.waiting`
  where the card is `blocked` or `board.done` where it is `done` (read each test's agent status). Rename
  `supervisor.test.ts` "moves a card to attention…" to name the real target column. Do not touch `src/web`
  product files yet; `src/web/App.tsx` and `src/web/Board.tsx` will still fail typecheck until Task 2.

- [ ] **Step 6: Run the server tests**

Run: `npx vitest run src/server`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/shared/types.ts src/server src/web/useMeerkatStream.test.tsx
git commit -m "feat: group the board into waiting, done, working and idle"
```

### Task 2: Web board renders four columns at every width

**Files:**
- Modify: `src/web/Board.tsx:36-48`, `src/web/App.tsx:9-13`, `src/web/styles.css:76-82,229-233`
- Test: `src/web/Board.test.tsx`, `e2e/board.spec.ts` (`e2e/reply.spec.ts` has no column titles; it must still pass)
- Modify: `README.md:3-5`, `docs/superpowers/specs/2026-11-22-reply-design.md:11`

**Interfaces:**
- Consumes: `BoardView` from Task 1.

- [ ] **Step 1: Write the failing unit tests** in `src/web/Board.test.tsx`

- `empty` becomes `{ waiting: [], done: [], working: [], idle: [] }`.
- Rename "renders three regions…" to `renders four regions in order with count badges`: two `blocked` cards in
  `waiting`, one `done` in `done`, one in `working`, none in `idle`. Assert
  `screen.getAllByRole('region').map((r) => r.querySelector('h2 > span')?.textContent)` equals
  `['Waiting for you', 'Done', 'Working', 'Idle']`, and the badges in those regions read `2`, `1`, `1`, `0`.
- `shows Nothing here in an empty column` expects length `4`.
- Reply-label and last-reply tests put `blocked` cards in `waiting`, `done` in `done`, `idle` in `idle`.

- [ ] **Step 2: Write the failing e2e tests** in `e2e/board.spec.ts`

- `shows sessions in columns`: `blocked-one` in region `Waiting for you`, `done-one` in `Done`; the region heading
  order equals `['Waiting for you', 'Done', 'Working', 'Idle']`.
- `moves a card when status changes`: push `working-one` → `blocked`, expect it in `Waiting for you`; push
  → `done`, expect it in `Done` and `Waiting for you` to have no `working-one` button.
- The progress test and `only read methods reach Herdr` expect `working-one` in `Done` after `done`.
- New `lays out four, two and one columns by width`: for `1280×800 → 4`, `1024×768 → 2`, `390×844 → 1`, call
  `page.setViewportSize`, count distinct `Math.round(box.x)` of the four regions' `boundingBox()` and expect the
  number; at each width expect
  `await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)` to be `true`.
- New `drawer stays on a card that moves from Waiting for you to Done`: open `blocked-one`'s card, push its status
  `done`, expect the dialog still visible and not showing `Session closed`, and the card in `Done`.

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run src/web/Board.test.tsx` and `npm run test:e2e`
Expected: unit FAIL (no region `Waiting for you`); e2e FAIL (the old page reads `board.attention`, which the
Task 1 server no longer sends).

- [ ] **Step 4: Implement.** `Board` renders `ColumnView`s titled `Waiting for you` (`board.waiting`), `Done`,
  `Working`, `Idle`. `findCard` in `App.tsx` searches `[...board.waiting, ...board.done, ...board.working,
  ...board.idle]`. CSS: `.board` default `grid-template-columns: repeat(2, minmax(0, 1fr))`; add
  `@media (min-width: 1100px) { .board { grid-template-columns: repeat(4, minmax(0, 1fr)); } }`; keep the
  `max-width: 719px` one-column rule.

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run && npm run typecheck && npm run lint && npm run test:e2e`
Expected: all PASS, no errors.

- [ ] **Step 6: Update the text.** README lines 3-5: "in four live columns (Waiting for you, Done, Working, Idle)".
  Reply design intent line 11: "a session lands in Waiting for you (Needs attention before 2026-11-23)". Run
  `npm run format:check`.

- [ ] **Step 7: Commit**

```bash
git add src/web e2e README.md docs/superpowers/specs/2026-11-22-reply-design.md
git commit -m "feat: show Waiting for you and Done as separate columns"
```

### Task 3: Verify, push, PR

- [ ] **Step 1:** `npm run lint && npm run typecheck && npm run format:check && npm test && npm run test:e2e`; all
  pass.
- [ ] **Step 2:** `git push -u origin feat/four-columns`.
- [ ] **Step 3:** `gh pr create --base main`, title `Split Needs attention into Waiting for you and Done`; body: the
  mapping table, widths, what is unchanged, test evidence, and "Reload any open Meerkat tab once after
  restarting Meerkat." Do not merge; do not comment.
