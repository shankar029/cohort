# App Correctness Push — Plan

**Goal:** Make delivery trustworthy: QA truly verifies before sign-off, and validate
that agents deliver correctly on medium-scale greenfield (parallel epics) and
brownfield projects.
**Status:** in progress

## Threads

### 1. QA does thorough E2E before sign-off (CODE FIX)
Today QA is an ungated verifier: its "sign off" is accepted on narration alone.
Make sign-off **evidence-enforced**:
- Orchestrator runs the project's own test/E2E command in the epic clone and
  checks exit code; QA cannot reach `review`/`done` unless tests actually passed
  (or, if no test tooling exists, QA must have *added* it and it passed).
- Detect the test command from the repo (`package.json` scripts: `test:e2e` →
  `e2e` → `test`; or a configured override in ProjectSettings).
- On failure/absence: QA task escalates/loops (retry → fix task) instead of a
  false green. Cite the command + output as evidence in the completion report.
- Keep it robust: time-boxed run, captured output, never hang the manager loop.

### 2. Parallel epics on a medium-scale app (REAL-SDK EVAL)
Rebuild a minimal eval harness (isolated port + DB + scratch repo, real adapter).
Drive a medium-scale greenfield app decomposed into **≥2 concurrent epics** and
verify every agent works and delivers: real files committed, QA gate enforced,
PRs raised and merged, epic → done. Capture findings → fixes.

### 3. Brownfield medium-scale comprehension (REAL-SDK EVAL)
Point the team at an existing medium-scale repo and give it a change that
requires understanding the established structure, coding style, and design
patterns. Evaluate whether agents follow existing conventions vs. reinventing.
Capture findings → fixes.

## Open questions (see chat) — answers drive scope
1. QA enforcement level: hard-gate on real test-run exit code (recommended) vs.
   stricter evidence-only.
2. Run the real-SDK evals now (needs your Copilot auth + ~40 min each) vs. build
   harness + protocol and you trigger.
3. Targets: greenfield app choice; brownfield repo choice.

## Steps
- [ ] 1. Implement QA E2E enforcement gate + repo test-command detection
- [ ] 2. Unit/integration tests for the QA gate (fake adapter)
- [ ] 3. Full gate + commit (Thread 1)
- [x] 4. Rebuild eval harness (real adapter, isolated port/DB/repo) ✅ 2026-08-25 — `evals/` (fake-mode self-test green)
- [ ] 5. Greenfield medium-scale parallel-epics run + findings
- [ ] 6. Brownfield medium-scale run + findings
- [ ] 7. Fixes from evals + re-validate + report

## Risks
- Real-SDK evals are slow, consume quota, and need auth; results are
  non-deterministic (LLM). Brownfield run modifies a real repo — use a scratch
  clone, never a repo you care about.
