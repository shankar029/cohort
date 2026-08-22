# ateam — Thorough Test & Capability-Evaluation Plan

**Goal:** (1) Exercise every UI feature in a real browser via Playwright, covering all
scenarios; (2) evaluate the Team Lead + agents on a medium-complexity project with the
**real** Copilot SDK, and analyze how the Lead runs the project — decomposition,
assignment, agent work quality, communication, review/merge, and end-to-end ownership.
**Status:** in progress

## Approach — two isolated halves (no disruption to the live dev server)

- The live dev server (ports 4319/5319, **real SDK**) already hosts a "Chess" project.
  I will **not** touch it.
- **Half 1 (feature coverage):** a new Playwright spec on the existing isolated harness
  (own build, `ATEAM_FAKE_SDK=1`, `ATEAM_DB=:memory:`, port 4399). Deterministic, free,
  fast. Captures screenshots into `test-results/coverage/`.
- **Half 2 (capability eval):** a dedicated **real-SDK** instance on a separate port +
  its own on-disk DB, pointed at a fresh scratch git repo. Long-running, real LLM cost.

## Half 1 — Feature coverage (Playwright, fake SDK) ✅ DONE

- [x] Projects: create, list, switch.
- [x] Dashboard: default landing, KPI cards, epic rows + progress.
- [x] Agents: catalog grid, add specialist, custom agent, edit agent, agent detail.
- [x] Board: add work item (assignee), columns, epic filter dropdown, detail modal,
      progress bar + slider, Lead-owned epic.
- [x] Chat: send → Lead reply, agent contribution, threads rail, markdown, escalation
      question → answer resumes.
- [x] Pull Requests: PR card, diff toggle, review, merge.
- [x] Notifications: list, unread badge, mark-all-read.
- [x] Activity: grouped feed, agent filter.
- [x] Settings: manual-approval toggle, save.
- [x] 9/9 tests green; 15 screenshots in `test-results/coverage/`.

_Note: fake-SDK content is templated (canned markers), so message text is not
"intelligent" — Half 1 proves the UI + wiring; Half 2 proves real capability._

## Half 2 — Capability evaluation (real SDK) ✅ DONE — see EVAL-REPORT.md

- [x] Scratch repo created + git-init (fresh baseline).
- [x] Real-SDK ateam instance on isolated port 4455 + own DB.
- [x] Built an 8-member team (Lead + PM + Architect + FE + BE + QA + DevOps + Docs).
- [x] Submitted the URL-shortener requirement.
- [x] Observed epic planning, decomposition, assignment, execution, group discussion,
      escalations, and QA gating; inspected the real git worktree/commits.
- [x] Wrote analysis (`EVAL-REPORT.md`).

**Headline:** orchestration/planning/communication/judgment are strong and code quality
is high when written, but a **SEV-1 worktree/cwd mismatch** means agents write real files
to `repoDir` (on `master`) instead of the epic worktree — so commits capture only
`.ateam/tasks` markers and the pipeline delivers ~no code. Full findings + prioritized
fixes in `EVAL-REPORT.md`.

## Verification

- Half 1: `npx playwright test tests/e2e/coverage.spec.ts` green; screenshots reviewed.
- Half 2: manual observation via API/DB/WS + git inspection; written analysis.

## Risks

- Half 2 makes real LLM calls (token cost) and can run many minutes. Isolated instance
  - scratch repo keep it safe; main/master never touched (worktree-per-epic).

## Decisions log

- 2026-08-21 — run both halves in **isolated instances**; never touch the live server or
  the user's Chess project.

## Fixes applied (Phase 1–3) — all green, one commit per phase

**Phase 1 — delivery correctness (`d81e075`, `c78433b`), validated with the real SDK:**
- SEV-1 worktree/cwd: agents wrote to `repoDir` not the epic checkout. Two root causes:
  - git worktrees confuse the SDK's workspace-root resolution (a worktree's `.git` is a
    file pointing to the main repo) → replaced per-epic worktrees with isolated local
    **clones** (own `.git`); `mergeEpic` fetches the epic branch from the clone first.
  - the **Team Lead implemented code itself** in `repoDir` → the Lead is hard-blocked from
    all non-read permission (no writes / mutating shell) and its prompt forbids implementing.
  - specialists' clone writes were rejected by auto-approve (clone is outside `repoDir`) →
    permission now approves writes in `repoDir` OR any managed clone under the worktree root.
- SEV-2 duplicate decomposition + agent-spawned parallel epics → the board is
  **system-owned**: `create_work_item`/`move_work_item` removed from agents; decomposition +
  Lead assignment + review fix-tasks are the only task sources. Decomposition is idempotent.
- SEV-3 false completion → a build task only reaches review/done if it produced real
  committed changes (diff excluding `.ateam/`); empty builds get a bounded retry then
  escalate to the user for guidance.
- SEV-3b sequencing → docs/devops depend on the core build; verifiers wait on all builds.
- SEV-4 → the epic clone is reclaimed after merge.

**Phase 2 — regression suite:** `delivery.test.ts` (SEV-1..4), `regression.test.ts`
(multi-project isolation, progress roll-up, comment-gated merge), `git.test.ts` updated to
the clone model, `coverage.spec.ts` (9 full-feature browser scenarios). Total **43
unit/integration + 13 E2E**.

**Phase 3 — UX (`842a5a1`):** chat no longer piles up empty “…” bubbles; in-flight agents
collapse into one chat-native typing row.
