# Card progress: design

Status: approved by the user on 2026-11-22 (option A of A/B/C).

## Why

Switching between sessions to check on them is painful. The board should show every session's latest progress
on the home page, without opening the side panel.

## Options considered

- **A (chosen):** each card shows the session's latest "update sentence" from Claude Code, plus how long ago it
  last changed.
- B: raw last lines of output on each card.
- C: A plus tap-to-expand on the card.

## Behaviour

- Each card shows the session's latest update sentence under the title, clamped to about 2 lines.
- Under it: `updated Xs/m ago`, counted from when that sentence last **changed**, not from each read. When the
  sentence is first seen (startup, new session, after a Herdr outage) the time is a lower bound and shown as
  `updated ≥ Xs ago`, like the existing status timer.
- Clicking a card still opens the side panel with the last 40 lines.

## Extracting the update sentence

Input: the pane's recent output from `agent.read` (`recent_unwrapped`, text, ANSI stripped), sanitized as today.

1. **Claude Code blocks.** A block starts at a line beginning with `⏺` followed by a space or U+00A0. Its
   continuation lines are the following non-blank lines that start with two spaces and are not `⎿` result
   lines. The block's text is the head plus its continuation lines, trimmed and joined with single spaces.
2. **Skip tool calls.** A block is a tool call when its head looks like `Name(…)` (`Bash(`, `Agent(`, `Read(`,
   `Update(`, `Write(`, `Skill(`, …) **or** when the next non-blank line after its continuation lines is a `⎿`
   result line. Claude Code sometimes renders a Bash call by its description instead of `Bash(`
   (`⏺ Reading the pane output…` then `  ⎿  $ printf …`), so the `⎿` rule is needed.
3. The update sentence is the text of the **last** block that isn't a tool call.
4. **Fallback** when the output has no `⏺` blocks at all (non-Claude agents): the last non-empty line that
   isn't terminal chrome:
   - lines made only of box-drawing characters (`───`, `╭`, `│`, `╰` frames),
   - lines starting with `❯` (prompt, autosuggestions, echoed user input), whether followed by a space,
     U+00A0 or nothing,
   - the status bar (`⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt …`),
   - spinner and timing lines (`· Flummoxing… (44s · ↓ 2.3k tokens)`, `✻ Churned for 4s · done 20:39`).
5. If `⏺` blocks exist but all of them are tool calls, there is no new sentence: the card keeps the one it
   already shows.
6. The sentence is capped at 280 characters (ending in `…`) to keep the board stream small.

## Freshness

- Each **working** session is re-read about every 10 s.
- Every session is read on first load, when it appears, and whenever its status changes.
- Reads run one at a time. Only the existing allow-listed, read-only `agent.read` is used; no new Herdr
  methods.
- While Herdr is unreachable nothing is read; after reconnecting every session is read again.

## Unchanged

Read-only; listens on 127.0.0.1 only; GET only; no CORS; no new dependencies.
