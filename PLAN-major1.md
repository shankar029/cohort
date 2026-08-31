# MAJOR-1 — Spec-derived acceptance probe as a required epic gate

**Goal:** Add a deterministic, machine-checkable acceptance probe, run against the
integrated epic tree, as a REQUIRED epic-level gate that BLOCKS merge on failure —
independent of the agents' own unit tests (which can pass a wrong contract).
**Status:** done

## Root cause (from live run "Snippet Vault")
Green agent-authored tests + green build/constraint gates are necessary-but-not-
sufficient: the builder wrote impl AND tests to the SAME wrong contract, and the
epic acceptance gate (`evaluateAcceptance`) is itself LLM-narrated, so it shares
the blind spot. Only the independent PR code-reviewer caught the real mismatch.

## Design
A probe is an executable command run in the integrated epic clone at finalize.
Exit 0 = pass, non-zero = fail (blocks merge), absent = skip (n/a).

**Resolution priority (qaGate `resolveAcceptanceProbe`):**
1. project `settings.acceptanceCommand` (explicit override — the deterministic
   test/eval lever).
2. `.ateam/acceptance.mjs` convention → `node .ateam/acceptance.mjs` (authored by
   the QA/architect from the SPEC, committed to the epic branch — real-mode path).
3. none → `{ran:false}` → the check is `skip` (never blocks a probe-less epic).

Independence is structural: the probe is authored by the QA/architect from the
REQUEST/criteria (the contract), separate from the builder's implementation + unit
tests, so it breaks the self-consistency that fooled the gate.

## Steps
- [x] `domain.ts`: `ProjectSettings.acceptanceCommand?: string`.
- [x] `api.ts`: `acceptanceCommand` in `updateProjectSettingsSchema`.
- [x] `app.ts`: merge `acceptanceCommand` in the settings PATCH.
- [x] `qaGate.ts`: `resolveAcceptanceProbe(dir, override?)` + `runAcceptanceProbe(dir, override?, timeoutMs?)`.
- [x] `verification.ts`: add `acceptance-probe` to epic `requiredChecks`.
- [x] `orchestrator.ts` `finalizeEpic`: run the probe after build/constraint/LLM-
      acceptance; fail → record `acceptance-probe:fail` + `handleFailedAcceptanceProbe`
      (shared remediation budget, then escalate); pass/absent → record status.
- [x] `orchestrator.ts` `decomposeEpic`: best-effort probe-authoring turn (QA >
      architect > lead) that writes `.ateam/acceptance.mjs` into the epic worktree
      and commits it. Never blocks dispatch.
- [x] Tests: qaGate unit (pass/fail/absent), verification unit (required list),
      integration (seed probe → finalize blocks on fail / passes on pass / records
      the check), eval scenario (`acceptance-probe`, fake), e2e (probe gate report).

## Verification
tsc · eslint · prettier · vitest · vite build · e2e app+coverage · eval --fake.
