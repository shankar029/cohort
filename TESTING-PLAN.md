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
