# Fix — design-first empty-turn recovery + Copilot quota observability

Follow-up to the live greenfield smoke (PR #5). The user asked to take on the
recommended fix and re-run the smoke.

## What I changed (3 commits)
1. **`fix(orchestrator)` — recover design-first from an empty Architect turn.**
   `designThenEnrich` used a single design attempt guarded by `if (!text) return`,
   so an empty (tool-only) Architect turn silently no-op'd design-first. Replaced
   with a bounded attempt plan that never strands the board:
   Architect → text-only retry (same designer) → **fall back to the Team Lead**.
   A crashed turn is treated like an empty one; timeouts still short-circuit to the
   template floor; only when every attempt yields no text do we proceed design-less
   (now with a clear "no text after retries" event).
   Tests: `fakeAdapter` gains role-aware markers `[[ARCH_EMPTY]]`,
   `[[DESIGN_EMPTY_ONCE]]`; `designFirst.test.ts` adds 2 regression tests
   (Lead takeover; same-designer text-only recovery). Both fail without the fix.

2. **`fix(adapter)` — surface Copilot `session.error` (quota/402, auth, outages).**
   `realAdapter` only listened for `assistant.*`, so a provider error was swallowed
   and looked identical to "the agent produced nothing". Now logs a greppable
   `[copilot] session error (<type>) [<code>]: <msg>`. Deliberately NOT injected
   into the turn result, so never-strand paths stay intact.

3. **`feat(evals)` — smoke detects an ENVIRONMENT-INVALID (quota) run.**
   The smoke's only environment guard was auth (401); a 402 quota run was scored as
   a genuine AC4/AC5 failure. `harness.detectEnvironmentIssue()` now flags the
   quota/session-error line → `outcome.environmentInvalid` + `environmentError`;
   `run.mjs` adds an `AC-H — environment valid` check and a prominent ENV-INVALID
   banner. `harness.selftest.mjs` → 8/8. Fake regression unaffected.

## The decisive finding (supersedes PR #5's root cause)
Live smoke runs 1/2/3 all showed every agent turn empty. A minimal direct-SDK
probe (`evidence/quota-probe.txt`) proved the cause: **the Copilot account is out
of monthly quota — every model call fails with `session.error errorType=quota,
statusCode=402`**, so zero tokens / empty text for ALL agents. PR #5's "empty
Architect turn" was a *symptom* of quota exhaustion, not a design-first defect.

**No orchestrator change can fix a 402.** The design-first fix (commit 1) is a
genuine, unit/integration-tested robustness improvement, but it CANNOT be
validated live until Copilot quota resets or a different subscription is used.

## AC verdicts (this task)
- **Design-first empty-turn recovery: VERIFIED offline** — 2 regression tests +
  full suite 346 pass / 1 skip.
- **Quota observability + smoke ENV-INVALID detection: VERIFIED** — selftest 8/8;
  fake regression green; adapter logs the 402.
- **AC4 / AC5 live: VERIFIED LIVE (2026-09-17, quota restored).** See
  `evidence/run4-live-pass/`. Real adapter, greenfield click-counter epic:
  - **AC5**: `designPersisted=true`, `designStatedStack=true`,
    `designEnrichedTasks=true`. The Architect persisted a concrete stack BEFORE
    builders acted: *"Use **Vite + React + TypeScript** with **Vitest + Testing
    Library**…"* + a `createCounter(...)` shared contract + an `aria-live`
    accessibility contract (`evidence/run4-live-pass/persisted-design.md`).
  - **AC4**: `frontendProducedCode=true`, **15 real files** (`src/App.tsx`,
    `src/counter.ts`, `src/main.tsx`, `index.html`, `vite.config.ts`, colocated
    tests…), **`userQuestionsRaised=0`** — the greenfield Frontend did NOT stall.
    The original "no code" bug is fixed live.
  - **AC-H**: `environmentInvalid=false`, `authIssue=false`; token usage healthy
    (165M in / 4M out over 325 turns).
  - Note: the run's `completed=false` only because the PR sat in
    `changes_requested` (QA loop) past the 36-min window — orthogonal to AC4/AC5,
    which were all satisfied well before that.

## Finishing command (when quota is restored)
```
ATEAM_DESIGN_TIMEOUT_MS=240000 node evals/run.mjs design-first --port=4620 --timeout=36
# Expect: 'AC-H — environment valid' ✅ (no 402). Then AC5 (designPersisted /
# designStatedStack / designEnrichedTasks) and AC4 (frontendProducedCode) become
# meaningful. If the Architect emits an empty turn, the new Lead fallback should
# still persist a design.
```

## Gates
G-typecheck ✅ · G-lint ✅ · G-unit/integration 346 pass/1 skip ✅ · G-selftest 8/8 ✅
· G-fake-regression ✅ · G-live ✅ **PASS** (quota restored 2026-09-17; all 7 acceptance
checks green — AC4/AC5/AC-H verified live).
