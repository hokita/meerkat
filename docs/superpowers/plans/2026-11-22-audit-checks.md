# meerkat audit checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A PR cannot add a high/critical prod dependency or an unpinned action to meerkat, and a nightly run on `main` catches new advisories in prod and dev deps and unpinned actions, with Dependabot alerts and security PRs on.

**Architecture:** New jobs in the existing `ci.yml` (PR gate), a new `audit-nightly.yml` (schedule + `workflow_dispatch`), a `dependabot.yml`, a bash `scripts/check-action-pins.sh` tested through vitest, and all `uses:` pinned to commit SHAs. meerkat has no deployment, Dockerfile or Go, so the image, runtime and govulncheck layers do not apply.

**Tech Stack:** GitHub Actions, npm audit, bash, vitest, Dependabot, GitHub rulesets.

**Spec:** `/Users/hokita/ghq/github.com/hokita/orch/docs/superpowers/specs/2026-11-22-audit-checks-design.md` (meerkat row in §7, plus §5, §8, §9, §11)

## Global Constraints

- No code comments, no lint/type/audit ignores. No `|| true`, `continue-on-error`, `--ignore-unfixed`, or audit-level tricks.
- Gate threshold: high and critical. Commands: `npm audit --omit=dev --audit-level=high` (prod), `npm audit --audit-level=high` (dev, nightly only).
- Every `uses:` is a 40-char commit SHA with no trailing `# vX` comment.
- Node stays pinned to exactly `24.22.3` everywhere; `npm run check:node-pins` must stay green.
- Nightly cron in 18:00–18:30 UTC; meerkat uses `20 18 * * *`, plus `workflow_dispatch`.
- No new secrets, no project IDs, billing IDs or emails in committed files (public repo).
- Dependabot: npm `open-pull-requests-limit: 0`; github-actions weekly, one grouped PR.
- Never merge; the orchestrator merges. Merging to `main` has no deploy for meerkat.

## Findings at plan time (2026-11-22, origin/main c1b0875)

- `npm audit --package-lock-only`: 0 vulnerabilities, all severities, prod (4 deps) and dev (257 deps). Matches the survey.
- No grpc-js/firebase in meerkat, so §6 overrides and the exception list do not apply. No advisory needs the user.
- GitHub: public, `vulnerability-alerts` → 404 (alerts off), security updates disabled, rulesets `[]`, secret scanning and push protection already on.
- Actions in use: `actions/checkout@v4` (latest v4.4.0 = `11d5960a326750d5838078e36cf38b85af677262`), `actions/setup-node@v4` (v4.4.0 = `49933ea5288caeca8642d1e84afbd3f7d6820020`), `actions/upload-artifact@v4` (v4.6.2 = `ea165f8d65b6e75b540449e92b4886f43607fa02`). Latest majors are v7 for all three.

## PRs

1. **Fix PR: none.** Spec §7 lists "none (0 findings)" and §9 lets meerkat go straight to step 3. Task 0 re-checks this at execution time.
2. **Gates PR** on branch `chore/audit-checks`: Tasks 1–4, opened as a draft PR, red demo, then ready for review.

## Review Focus

- A `uses:` value in quotes (`'actions/checkout@<sha>'`) must pass; the check must not fail on YAML quoting.
- A short SHA (`@11d5960`) or a SHA followed by a comment must fail, not pass as "looks like a hash".
- A `.yaml` workflow file must be scanned, not only `.yml`.
- An empty or wrong workflows directory must fail, so the check never goes green by scanning nothing.
- The Dependabot grouped github-actions PR bumps v4 → v7 majors; it must still pass `check:node-pins` and `check:action-pins` (both read SHAs/versions only, so it will), and the bump itself is reviewed as a normal PR.

---

### Task 0: Re-confirm there is nothing to fix first

- [ ] **Step 1:** In the worktree: `npm ci`, then `npm audit --omit=dev --audit-level=high` and `npm audit --audit-level=high`. Expected: both `found 0 vulnerabilities`, exit 0.
- [ ] **Step 2:** If either reports a high+, stop and report the advisory to the orchestrator: a fix PR (or, with no upstream fix, a per-entry user decision) comes first. Never add an exception.

### Task 1: Action pin check, tested

**Files:**
- Create: `scripts/check-action-pins.sh`, `scripts/check-action-pins.test.ts`
- Modify: `vitest.config.ts` (add project `scripts`: environment `node`, include `scripts/**/*.test.ts`), `tsconfig.test.json` (include `scripts/**/*.test.ts`), `eslint.config.js` (add `scripts/**` to the node-globals `files`), `package.json` (script `"check:action-pins": "scripts/check-action-pins.sh"`)

**Interfaces:**
- Produces: `scripts/check-action-pins.sh [workflows-dir]`, default `.github/workflows` under the repo root. Scans `*.yml` and `*.yaml`. Each `uses:` value, with surrounding quotes stripped, must match `^[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+@[0-9a-f]{40}$`. Each offender prints `unpinned action: <file>:<line>: <text>`. Exit 1 on any offender, or `no workflow files in <dir>` when none exist. Success prints `All actions are pinned by SHA`, exit 0.

- [ ] **Step 1: Write the failing tests** in `scripts/check-action-pins.test.ts`. Each test writes workflow files into a `mkdtemp` dir and runs the script with `spawnSync('scripts/check-action-pins.sh', [dir])`:
  - `passes when every uses is a full SHA` → status 0, stdout contains `All actions are pinned by SHA`
  - `passes a quoted SHA pin` → status 0
  - `fails a tag pin and names the line` (`actions/checkout@v4` on line 7 of `ci.yml`) → status 1, stdout contains `ci.yml:7:`
  - `fails a branch pin` (`@main`) → status 1
  - `fails a short SHA` (`@11d5960`) → status 1
  - `fails a SHA with a trailing comment` → status 1
  - `scans .yaml files` (tag pin in `x.yaml`) → status 1
  - `fails when the directory has no workflow files` → status 1, stdout contains `no workflow files`
- [ ] **Step 2:** `npx vitest run --project scripts`. Expected: FAIL (script missing).
- [ ] **Step 3:** Write `scripts/check-action-pins.sh` in the style of `scripts/check-node-pins.sh` (`set -euo pipefail`, `grep -nHE`), and the config changes above.
- [ ] **Step 4:** `npx vitest run --project scripts`. Expected: 8 passed.
- [ ] **Step 5:** `npm run check:action-pins` on the real repo. Expected: FAIL, 5 `unpinned action` lines (the red half for Task 2).
- [ ] **Step 6:** Commit `test+feat: check that every action is pinned by SHA`.

### Task 2: Pin actions, add the PR gate jobs

**Files:** Modify `.github/workflows/ci.yml`, `scripts/check-node-pins.sh` (setup-node count `2` → `3`)

- [ ] **Step 1:** Replace every `uses:` with the SHAs from "Findings" (same majors as today, no behaviour change). `npm run check:action-pins`. Expected: `All actions are pinned by SHA`.
- [ ] **Step 2:** Add two jobs. `prod-audit`, `name: Prod deps audit`: checkout, setup-node `'24.22.3'`, `npm audit --package-lock-only --omit=dev --audit-level=high` (`--package-lock-only` audits the same lockfile tree without an install). `action-pins`, `name: Action pins`: checkout, `scripts/check-action-pins.sh`.
- [ ] **Step 3:** `npm run check:node-pins`. Expected: FAIL `expected 2 setup-node node-version line(s), found 3` (red). Change the count in `scripts/check-node-pins.sh` to `3`, re-run. Expected: `All Node pins are 24.22.3`.
- [ ] **Step 4:** Commit `ci: pin actions by SHA and gate PRs on prod audit and action pins`.

### Task 3: Nightly workflow and Dependabot

**Files:**
- Create: `.github/workflows/audit-nightly.yml`, `.github/dependabot.yml`
- Modify: `scripts/check-node-pins.sh` (setup-node count `3` → `5`)

- [ ] **Step 1:** `audit-nightly.yml`: `name: Audit (nightly)`, `on: schedule: cron '20 18 * * *'` and `workflow_dispatch`, `permissions: contents: read` (no `id-token`: meerkat authenticates to nothing). Jobs `Prod deps audit` and `Dev deps audit` (checkout, setup-node `'24.22.3'`, the two npm audit commands with `--package-lock-only`) and `Action pins` (as in ci.yml). All `uses:` SHA-pinned.
- [ ] **Step 2:** `npm run check:node-pins`. Expected: FAIL `found 5`. Change the expected count to `5`. Re-run. Expected: `All Node pins are 24.22.3`.
- [ ] **Step 3:** `dependabot.yml`: `version: 2`; `npm`, `directories: ["/"]`, weekly, `open-pull-requests-limit: 0`; `github-actions`, `directories: ["/"]`, weekly, `groups: { actions: { patterns: ["*"] } }`. No docker or gomod entry.
- [ ] **Step 4:** Commit `ci: add nightly audit and Dependabot config`.

### Task 4: Full verification, draft PR, red demo

- [ ] **Step 1:** `npm ci && npm run check:node-pins && npm run check:action-pins && npm run lint && npm run format:check && npm run typecheck && npm test && npm run build && npm run test:e2e`. Expected: all exit 0 (Playwright chromium 1254/1255 is already in the local cache; nothing is downloaded). Then both npm audit commands: `found 0 vulnerabilities`.
- [ ] **Step 2:** Push and open the gates PR **as a draft** against `main` (body ends with the Claude Code attribution line). Expected: `Check`, `E2E`, `Prod deps audit`, `Action pins` all green.
- [ ] **Step 3: Red demo.** Branch `chore/audit-red-demo` from `chore/audit-checks`: `npm install --save-exact lodash@4.17.20` (GHSA-35jh-r3h4-6jhm, high, fixed in 4.17.21) and change one `uses:` in `ci.yml` back to `actions/checkout@v4`. Push, open a draft PR with base `chore/audit-checks`. Expected: `Prod deps audit` FAIL naming lodash, `Action pins` FAIL naming `ci.yml`. Record both run URLs in the gates PR body, close the demo PR, delete the branch locally and on the remote. Never merge it.
- [ ] **Step 4:** Confirm the gates PR is green again on its own head, mark it ready for review, hand it to the orchestrator (Codex review, merge).
- [ ] **Step 5:** After merge: `gh workflow run audit-nightly.yml --ref main`, then `gh run watch`. Expected: all three nightly jobs green. Record the run URL.

## GitHub settings (orchestrator, via `gh api`)

| When | Setting | Command | Read back |
|---|---|---|---|
| Before Task 4 Step 2 (spec step 0) | Dependabot alerts | `gh api -X PUT repos/hokita/meerkat/vulnerability-alerts` | `gh api -i repos/hokita/meerkat/vulnerability-alerts` → 204 |
| After the gates PR merges and its nightly dispatch is green (spec step 4) | Dependabot security updates | `gh api -X PUT repos/hokita/meerkat/automated-security-fixes` | `.security_and_analysis.dependabot_security_updates.status == "enabled"` |
| Same time | New ruleset "Protect main" on `~DEFAULT_BRANCH`, enforcement active, no bypass actors: `deletion`, `non_fast_forward`, `pull_request` (0 approvals), `required_status_checks` with contexts `Check`, `E2E`, `Prod deps audit`, `Action pins` | `gh api -X POST repos/hokita/meerkat/rulesets --input <json>` | `gh api repos/hokita/meerkat/rulesets/<id>`; the next PR shows the four checks as Required |
| — | Secret scanning + push protection | already enabled; no change | `.security_and_analysis.secret_scanning*` |

The dependency graph is always on for public repos. Caveat from spec §5: GitHub disables the schedule after 60 days without repo activity and emails first; on that email, `gh workflow enable audit-nightly.yml`.

## Out of scope for meerkat

Image scan, deployed runtime, govulncheck, grpc-js override, exception list (no findings), the v4 → v7 action majors (left to Dependabot's grouped PR), Playwright browser versions, the local Volta default.
