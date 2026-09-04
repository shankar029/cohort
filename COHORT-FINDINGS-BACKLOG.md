# Cohort — Findings Backlog (from brownfield validation)

Consolidated, de-duplicated findings from Phase 0/1 + the cross-layer collaboration
scenario. **Grouped by theme** so related items can be fixed together AFTER Phase 2.
Status legend: `[ ]` open · `[~]` in progress · `[x]` fixed.

> Source runs: `LIVE-BROWNFIELD-PLAN.md` (Phase 1 project `prj_-h_RZvZe_LTf`;
> cross-layer project `prj_r4PhmYjBz4dz`). Fixture: `C:\Code\Projects\ateam-bf`.

---

## Group A — Repository-instruction ingestion (`src/server/agents/context.ts`)
- [x] **A1. Nested/per-package instruction files are ignored.** ✅ FIXED — `collectRepoInstructions()`
  now walks nested `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`/`CONVENTIONS.md`/`.cursorrules`/`.windsurfrules`
  (BFS, depth≤6, ≤60 files, ignores node_modules/.git/build/etc.). `packages/*/AGENTS.md` is injected.
- [x] **A2. Instruction truncation can silently drop rules.** ✅ FIXED — result now reports
  `truncatedFiles`/`droppedFiles`; the prompt appends a visible `⚠ …exceeded the context budget`
  note so agents know to open the file directly. Tests in `tests/unit/repoInstructions.test.ts`.

## Group B — Version control / commit conventions (`src/server/orchestrator.ts`)
- [x] **B1. Commit messages aren't Conventional-Commits.** ✅ FIXED — new
  `src/server/commitStyle.ts` centralizes every commit message; `ATEAM_COMMIT_STYLE=conventional`
  makes the harness emit `chore(merge): …`, `chore(sync)/(integrate): …`, and typed task commits
  (`fix|feat|docs|test|refactor|build(scope): …` inferred from title/stream). Default stays `ateam`
  (unchanged). `findEpicMergeCommit` grep kept in lockstep (verified git BRE matches literal parens).
  Tests in `tests/unit/commitStyle.test.ts`.

## Group C — Decomposition & role boundaries (`orchestrator.ts` decomposeEpic + prompts)
- [ ] **C1. Cross-layer bugs get a single-owner task that under-covers.** For an existing
  codebase, decomposition converges on ONE owner (`:1003`). In the cross-layer run the
  backend engineer's task fixed only the data layer; the frontend fix was made by QA
  during "verify", and full coverage only emerged because review caught the gap.
  **Sev: Med.** *Fix idea:* detect multi-package/multi-layer scope and fan out per-layer
  subtasks (or require the owner to enumerate all affected layers).
- [ ] **C2. Fuzzy role boundaries.** The QA agent edited production frontend code
  (`packages/web/public/format.js`) during a verify task instead of routing back to an
  engineer. Right outcome, unclear ownership. **Sev: Low–Med.** *Fix idea:* constrain
  verify/review roles to tests+comments, or make cross-role edits explicit hand-offs.

## Group D — Observability / auditability
- [x] **D1. Recordings not written under the real adapter.** ✅ RESOLVED — root cause was a
  harness/config omission, NOT a Cohort defect: the recorder (`runTurn` begin/end) is
  adapter-agnostic and only gated on `settings.recordSessions`, which the live runs never
  enabled. Added `ATEAM_RECORD_SESSIONS=1` to default recording ON for new projects
  (headless/live), threaded config→app→`createProjectWithLead`. Documented in `.env.example`.

## Group E — Repo hygiene (Cohort itself, pre-existing; not agent-caused)
- [x] **E1. `npm run lint` red at baseline** ✅ FIXED — was 104 errors, now **0**. Added an
  eslint override giving `scripts/**` + `evals/**` Node+browser globals, ignored `**/._*`
  scratch files, disabled `ban-ts-comment` for plain-JS scripts, removed one dead import.

## Group F — Epic convergence / orchestration robustness (`orchestrator.ts` manager loop + review)
- [ ] **F1. Epics can stall without converging to merge.** In Phase 2 t3 (test-data feeds), a
  heavily-specified brief led the reviewer to file 5+ BLOCKER subtasks; the epic spiraled into
  ever-more tasks, a `todo` fix-task was left **unstarted**, and ALL agents (including the Team
  Lead) went **idle** with the PR stuck in `changes_requested` — no merge, no failure, just a
  stall. A user chat nudge triggered MORE planning (spiral), not convergence. **Sev: Med–High.**
  *Evidence:* project `prj_BHp-G89Lj3wL`. *Fix ideas:* (a) manager loop must detect
  "assigned task in todo + all idle" and start/escalate it; (b) bound review re-decomposition and
  force a final converge-or-fail decision; (c) surface a terminal `stalled`/`failed` epic status
  instead of silent idle; (d) make nudges resume the existing plan rather than re-plan.

---

## Fix plan (after Phase 2)
1. **Group A together** (A1 nested discovery + A2 truncation) — one focused change to
   `context.ts` + a unit test with a nested fixture.
2. **B1** — small, self-contained; add a commit-message policy + config.
3. **F1** — orchestration robustness (convergence/stall). Medium; pairs with C1/C2 since both
   touch the manager loop + review decomposition. Re-run t3 to verify.
4. **C1/C2** — decomposition heuristics + role-permission prompts. Re-run the cross-layer scenario.
5. **D1, E1** — low-effort cleanups, batch with (1)/(2).

Phase 2 added **F1** (convergence/stall). Groups A–F are the fix set.
