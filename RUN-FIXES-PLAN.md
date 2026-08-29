# Run-Issues Fix Plan

**Goal:** Fix the 8 systemic issues surfaced by live run #2 so the team delivers
complex projects faithfully (no scope drift, no wrong-thing polishing).
**Status:** in progress

Source: `RUN-ISSUES.md` (live run `prj_IUPzF5KUig-r`, discarded).

## Fix order
- [x] **I1** Scope stream fan-out to the request (drop irrelevant ux/frontend/etc.). `11bb010`
- [x] **I6** Exclude non-implementing roles (researcher) from code-delivery fan-out. `11bb010`
- [x] **I7 + I2** Anchor review/QA/acceptance on the ORIGINAL request + hard-enforce constraints. `4e11e52`
- [x] **I3** `npm install` in the integrated clone before the build/QA gate. `58ab3ea`
- [x] **I5** Gate contract-consuming tasks on the (bounded) design turn. `f1ad9f6`
- [x] **I8** Per-epic review-round budget that escalates instead of looping forever. `64e4ef2`

**Status:** all 8 issues fixed; suite green.

## Verification
- `npx tsc -p tsconfig.json --noEmit` clean
- `npx eslint src tests --max-warnings 0` clean
- scoped prettier clean
- unit/integration suite green (+ new tests per fix)
- one commit per fix

## Decisions log
- 2026-08-28 — user chose to discard the stuck epic and fix now (all systemic issues captured).
