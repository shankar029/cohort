# F1b + C1/C2 — Convergence & Role-Boundary Fixes

**Goal:** Make epics converge (bound the review grind) and cover cross-layer work
correctly (fan out per layer; keep verify roles from silently editing prod code).
**Status:** done (unit-proven; t3 live-converged). Cross-layer C1 live run: optional/pending.

## RESULTS (2026-09-02)
**t3 live re-verify: PASS — converged & merged.** The task that STALLED then GROUND for
80+ min last session now merges cleanly: epic done, 12 tasks done, PR merged into master,
acceptance met (`gen-feed --users 5 --from 2026-05-01 --days 3` → exactly 15 rows), and
`npm test` green (8/8, deps installed). Getting there required fixing three real blockers
that were the ACTUAL cause of t3's non-convergence (not F1b itself):
- **Constraint checker false positives (2 bugs, fixed + unit-tested + live-validated):**
  (a) `no-external-deps` flagged internal `@repo/*` workspace packages as external deps;
  (b) `IMPORT_RE` mis-read a quoted string literal `kind: 'import'` as a side-effect import,
  capturing garbage as a module specifier. Both produced phantom violations → endless
  rework. Live confirmation after the fix: `Constraint gate: honored no-external-deps`.
- **Stall mask (fixed + unit-tested):** `watchForStall` reset the stall clock whenever
  `running.size>0`, so ONE leaked run guard made the manager think work was progressing
  forever and recovery never fired (observed live: t3 wedged 7+ min, an assigned todo task,
  all agents idle, zero stall events). New pure `boardHasLiveWork()` ignores runs past the
  watchdog. This is the F1a blind spot.
- **F1b (review budget):** implemented + unit-proven, but NOT triggered live — once the real
  blockers above were fixed, review converged via normal APPROVAL before hitting the budget.
  F1b remains the correct safety net for genuinely non-convergent review; it just wasn't
  needed here. Honest: unit-proven, not live-exercised.
- **C1 (fan-out):** unit-proven. t3 is single-layer (data) so fan-out correctly did NOT
  apply. Live cross-layer exercise still pending (optional given cost).
- **C2 (verify boundary):** live-observed QA review-fixes targeting TEST files (consistent).

**New findings surfaced (backlog Group G):**
- QA "fix" task sign-off loop: a review-fix routed to QA is treated with verify/sign-off
  semantics ("QA cannot sign off"), looping on Retry and never reaching `review` — blocks the
  epic from re-reviewing. Worked around live via "Skip". Role-confusion, related to C2.
- An agent dropped `packages/web` from root `workspaces` (out-of-scope config edit) and it
  merged (gates didn't catch it — web has no failing tests).

## Root-cause recap (empirical)
- **F1a (shipped):** idle-wedge stall from leaked run/park guards → `stallRecovery.ts`.
- **F1b (this):** even without a wedge, a single owner grinds an unbounded review
  loop — the reviewer keeps filing blockers, one engineer serially reworks them,
  the board freezes and never merges. The existing per-epic *round* cap
  (`maxReviewIter=3`) doesn't bite because a round rarely *completes* (fix tasks
  stay in-flight) and each round can spawn arbitrarily many fixes.
- **C1:** brownfield decomposition converges on ONE primary builder (deliberate, to
  avoid doc-only fan-out). For genuinely **multi-layer** work (data + frontend +
  api) that single owner under-covers, so a cross-layer bug got fixed by QA during
  its "verify" task instead of by an owner.
- **C2:** verify/review tasks can silently edit production code (QA edited
  `format.js`). Safe to forbid ONLY once C1 assigns each layer to a real builder.

## Design (deterministic + unit-testable cores; LLM prompts strengthened)
1. **F1b — cumulative review-fix budget → converge-or-escalate.**
   New pure `reviewBudgetDecision()` in `src/server/reviewBudget.ts`. Track a
   per-epic cumulative fix-task count; when `iter >= maxIter` OR cumulative fixes
   `>= maxReviewFixes` (env `ATEAM_MAX_REVIEW_FIXES`, default 12), park + ask the
   user (reuse the existing escalation) instead of spawning more fixes. Bounds the
   grind even when rounds never complete.
2. **C1 — multi-layer builder selection.**
   New pure `pickBrownfieldBuilders(content, coreBuilderNames)` in `streamScope.ts`.
   Returns single primary for single-layer work (unchanged) but the full set of
   in-scope code layers when the request clearly spans ≥2 of {backend, data,
   frontend, ux}. Each layer gets a `concrete: true` "real change + tests" task
   (not a doc task), so cross-layer bugs get an owner per layer.
3. **C2 — verify-role boundary.**
   Strengthen the `verify` task description: verify & report; do NOT modify
   production source; only touch test/doc files; hand defects back as findings.
   Safe now that C1 assigns each code layer to a builder.

## Steps
- [x] `reviewBudget.ts` + unit tests (6)
- [x] `pickBrownfieldBuilders` in `streamScope.ts` + unit tests (5)
- [x] Wire C1 into `decomposeEpic` (brownfield branch)
- [x] Wire C2 verify-description constraint
- [x] Wire F1b into `runEpicReview` + cumulative counter in `assignReviewFixes`
- [x] `.env.example` (`ATEAM_MAX_REVIEW_FIXES`, `ATEAM_STALL_MS`, `ATEAM_RUN_WATCHDOG_MS`)
- [x] BONUS constraint fixes (workspace pkgs + IMPORT_RE) + tests (4)
- [x] BONUS stall-mask fix (`boardHasLiveWork`) + tests (4)
- [x] Full suite + tsc + lint green (236 pass / 1 skip)
- [x] Live re-verify: t3 → converged & merged, acceptance met
- [ ] Live re-verify: cross-layer C1 fan-out (optional; unit-proven)
- [x] Update backlog + this plan

## Risks & rollback
- C1 fan-out could regress single-layer brownfield convergence → mitigated by a
  conservative multi-layer trigger (only ≥2 clearly-referenced code layers) and
  keeping single-owner as the default. Rollback: revert the `decomposeEpic`
  brownfield branch to always single-primary.
- C2 hard-forbid could leave a layer's bug unfixed → mitigated by C1 owning each
  layer first; keep wording firm but the deterministic behavior unchanged.

## Decisions log
- 2026-09-02 — F1b uses a cumulative fix budget (not just rounds) because rounds
  rarely complete under a single serial owner.
- 2026-09-02 — C1 fans out only genuine multi-layer scope; single-layer stays
  single-owner to preserve the convergence that made t1/t2/t5/t6/t7 pass.
