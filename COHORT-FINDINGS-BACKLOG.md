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
- [x] **F1a. Idle-wedge stall — leaked run/park guards.** ✅ FIXED — `stallRecovery.ts`
  `planStallRecovery()` (pure, 8 unit tests incl. the exact t3 repro) + `watchForStall` now
  clears stale TASK `running`/`awaitingInput` guards when provably idle-stalled (agent idle past a
  5-min watchdog => hung/crashed turn), restarts the hung agent session, and re-drives — instead of
  only posting a diagnosis. **Live-verified negative:** during a 1h25m real-SDK t3 run with the
  agent legitimately `working`, recovery correctly did NOT false-fire (0 spurious events). On
  server restart the *originally-stalled* t3 project resumed to done/merged.
- [ ] **F1b. Live-grind non-convergence (NEW, from the F1 re-run).** A DIFFERENT mode than F1a:
  a single owner stays `working` indefinitely on an unbounded review loop — the reviewer keeps
  filing BLOCKERs, the board freezes (e.g. `review:4,in_progress:3,todo:2`, PR `changes_requested`)
  and the epic never merges. F1a deliberately doesn't touch this (agent is genuinely working).
  **Sev: Med–High.** *Fix (folded into Group C):* bound review re-decomposition — cap rework rounds
  per PR/epic, then force a converge-or-escalate decision; split genuinely large work across owners;
  make a user nudge RESUME the plan rather than spawn more tasks.

---

## Fix plan (after Phase 2)
1. **Group A together** (A1 nested discovery + A2 truncation) ✅ DONE.
2. **B1** ✅ DONE.  **D1, E1** ✅ DONE.  **F1a** (idle-wedge stall) ✅ DONE.
3. **F1b + C1/C2 together** — the remaining structural work, all in the manager loop + review
   decomposition + role prompts: cap review re-decomposition (converge-or-escalate), split
   multi-layer work across owners, tighten verify/review role permissions, and make nudges resume
   the plan. Re-run t3 AND the cross-layer scenario to verify.

Groups A/B/D/E and F1a are shipped; F1b+C are the remaining set.
