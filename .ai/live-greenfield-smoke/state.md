# state.md — live-greenfield-smoke

Requirement: Prove, with the REAL Copilot adapter (not the fake), that on a
greenfield (empty) repo the shipped design-first orchestration works end-to-end:
- AC4: a builder (Frontend) DECIDES under uncertainty and produces real code
  instead of looping on clarifying questions (the original "no code" stall).
- AC5: the Architect (or Lead fallback) STATES a concrete greenfield stack and a
  design is persisted before builders act.
Deliverable: a repeatable, opt-in live smoke harness (committed) + captured
evidence from a real run + report; move AC4/AC5 from VERIFIED-WITH-LIMITATIONS
toward VERIFIED (live).

Tier: full loop (non-trivial: new harness code + live proof).
Branch: feat/live-greenfield-smoke (off main, post-merge of PRs #1/#2/#4).

## Environment facts (verified this session)
- FACT: `@github/copilot-sdk` installed & resolvable (node_modules/@github/copilot-sdk).
  [node require.resolve ok]
- FACT: RealCopilotAdapter connects LIVE — `new CopilotClient(); await client.start()`
  succeeds and `listModels()` returns [{id:"auto",...}] in THIS environment.
  [ran _copilotprobe.mjs under run.py → "STARTED ok" + MODELS auto]
- FACT: adapter selection = fake iff `ATEAM_FAKE_SDK==='1' || NODE_ENV==='test'`,
  else RealCopilotAdapter. [src/server/config.ts:44, src/server/index.ts:36-38]
- FACT: env has COPILOT_ENTRA_AUTH_AUD set (Entra-backed Copilot auth present).
- INFERENCE: only model "auto" is offered; agents can run on it (config.model ||
  project.settings.defaultModel).

## Acceptance criteria
- AC4: greenfield Frontend produces code files (no clarifying-question stall).
- AC5: Architect/Lead states a stack; a design is persisted before builders act.
- AC-H (harness): the smoke is repeatable, opt-in (not in default CI vitest,
  which forces the fake), bounded, and asserts AC4/AC5 with captured evidence.

## Progress
Current phase: 6 — Review + ship (I2 live verification complete)
Gates: G1 ✅ | G2 ✅ | G3 ✅ | G4 ✅ (I1) | G5 ✅ (AC-H proven; AC4/AC5 NOT-VERIFIED live with root cause — harness did its job) | G6 ⏳
Next action: independent review of the evals diff + AC reconciliation; probe; quality gate; report.html; commit; PR.
Blocked on: none

## Outcome (honest)
- AC-H (live smoke harness): VERIFIED — 7/7 self-tests; 2 bounded/isolated live runs; correctly measured a true-negative.
- AC4 (FE decides & produces code): NOT-VERIFIED live — FE stalled + escalated to user in BOTH runs.
- AC5 (Architect states stack; design persisted): NOT-VERIFIED live — architect design turn returned EMPTY → designThenEnrich no-op → epic_designs empty.
- Root cause: empty/tool-only architect turn silently collapses design-first; FE then has no design to anchor to and re-exhibits the no-code stall. See evidence/findings.md. These are product defects in design-first (PR #4), reopened as follow-ups — NOT harness defects.

## Increments
- [x] I1 — evals harness scoring + design-first scenario + 7 self-tests. Committed 3c217fa.
- [x] I2 — LIVE runs (×2) executed; evidence captured (run1/run2/findings.md); AC verdicts set.
