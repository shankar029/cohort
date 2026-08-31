# Verification-Gate Framework — Holistic Orchestration & Harness Redesign

**Goal:** Make task/epic completion **deterministic, effective, auditable, and
verifiable**. No task or epic may reach a terminal state ("review"/"done"/merged)
without a **passing, persisted, machine-checkable verification report**. Failures
become **tracked fix work items** (visible on the board), not silent passes,
restarts-into-the-void, or narration-trusted sign-offs.

**Status:** design → oracle review → implement (sliced) → eval (fake) → real LLM.

---

## 1. Why (evidence from live run `prj_uNeRcw4CqhGl`)

A headless "in-memory only, no external deps" expense API run exposed the core
defect class:

1. **Gates are a patchwork bolted to ONE transition.** Build/constraint/QA gates
   live only inside `runWorkItemInner`, behind `gate && produced && worktree &&
   parentId`. Retry / re-dispatch / "Skip" answers reach terminal states on other
   paths **without re-running them**.
2. **A task reached `done` while still violating a hard constraint AND without
   integrating** into the epic clone (epic worktree was empty). "done" is
   decoupled from "verified" and from "integrated".
3. **The Lead trusts agent narration** ("all gates green, 100% coverage") over
   deterministic evidence; the shipped code persisted to disk the whole time.
4. **Failures don't become tracked work.** The build/constraint/QA gates
   `restart → escalate`; they never create a visible, assignable fix task, so a
   stubborn violation just deadlocks on a modal question.
5. **Not auditable.** Gate outcomes are transient log events in a bounded ring
   buffer; there's no persisted per-task verification record to inspect after.

## 2. Design principles

- **Single chokepoint.** Exactly one function decides "may this task advance?":
  `verifyWorkItem(item) → GateReport`. Every path to `review`/`done` goes through
  it (or an explicit, recorded user override). No side-door `moveItem(_, 'done')`.
- **Deterministic + pure where possible.** Checks are code (filesystem scans,
  process exit codes), never an LLM judgment. Same inputs ⇒ same report.
- **Per-role spec.** Each stream declares its checks ("guardrails per agent").
- **Auditable.** Every report is persisted (DB) and emitted as a structured
  event; exposed via `GET /api/workitems/:id/verification`.
- **Effective failure handling.** A failing required check ⇒ a **scoped fix work
  item** assigned to the same agent, with a per-item fix-round budget; at the cap
  it **escalates to the user** (never silent-merges). Transient (no-output)
  failures still get one session restart first.
- **Integration ∈ Definition of Done.** A builder task cannot be `review`/`done`
  unless its branch integrated into the epic clone. "Skip" marks a distinct
  `skipped` outcome recorded in the report — never a clean "done".

## 3. The model

```ts
type CheckSeverity = 'required' | 'advisory';
type CheckStatus = 'pass' | 'fail' | 'skip'; // skip = not applicable (e.g. no test cmd)

interface CheckResult {
  id: string;              // 'produced' | 'build' | 'constraints' | 'tests' | 'integrated' | 'review-comments' | 'docs'
  severity: CheckSeverity;
  status: CheckStatus;
  detail: string;          // human summary
  evidence?: unknown;      // command, output tail, violation list, file list...
}

interface GateReport {
  workItemId: string;
  agentId: string;
  stream: string | null;
  ts: number;
  checks: CheckResult[];
  passed: boolean;         // no required check failed
  outcome: 'passed' | 'failed' | 'skipped';
}
```

`passed = checks.every(c => c.severity !== 'required' || c.status !== 'fail')`.

### Per-role check specs (`verificationSpec(stream)`)

| Stream | Required checks | Advisory |
|--------|-----------------|----------|
| backend / frontend / data / devops (builders) | `produced`, `build`, `constraints`, `integrated` | — |
| qa | `tests` (project test cmd must actually pass), `integrated` | — |
| reviewer | `review-comments` (no unresolved blocking comments) | — |
| security | `constraints` (+ future: dep-audit) | — |
| docs | `produced`, `integrated` | `docs-present` |

Checks reuse existing deterministic primitives: `producedRealChanges`,
`runProjectBuild`, `checkClone` + `epicConstraints`, `runProjectTests`, and the
integration result. Nothing new is "trusted"; this is a **consolidation +
uniform enforcement**, not a new trust surface.

## 4. Control flow (replaces the ad-hoc gate blocks in `runWorkItemInner`)

```
build task turn completes
  → commit on task branch
  → integrate into epic clone (serialized)      [existing]
  → report = verifyWorkItem(item, runDir, integrationResult)
  → persist report + emit 'verification' event
  → if report.passed:  moveItem(review); postTaskCompletion
  → else:
       recordFixRound(item)
       if fixRounds(item) < ATEAM_MAX_FIX_ITER:
          createFixTask(scoped, sameAgent, `fix: <failed checks>`, evidence)  // visible, tracked
          moveItem(item, 'review')  // the ORIGINAL is parked; the FIX task carries the work
          // (or keep item in 'in_progress' and spawn fix as blocker — see Q for oracle)
       else:
          escalate to user (Retry / Skip)  // Skip ⇒ report.outcome='skipped', recorded
```

Transient `produced=false` keeps the existing "restart once then escalate", but
now emits a `produced: fail` report for auditability.

## 5. Auditability & API

- **DB:** `verification_reports(work_item_id, agent_id, ts, passed, outcome, json)`
  — append-only; latest-per-item easily queried.
- **Event:** `verification` event type with `{ passed, outcome, checks }` detail.
- **API:** `GET /api/workitems/:id/verification` → latest + history.
- **UI (later):** a small gate badge on the board card / detail modal.

## 6. Harness / eval changes (deterministic, not narration)

- Harness reads `GET /api/workitems/:id/verification` (or a project rollup
  `GET /api/projects/:id/verification`) and asserts on **reports**, not chat text.
- New outcome fields: `verifiedTasks`, `failedRequiredChecks`,
  `tasksDoneWithoutPassingGate` (must be 0), `unintegratedDone` (must be 0).
- New scenario `gate-enforcement` reproducing this run: in-memory + tempted disk
  write. Asserts: (a) a `constraints` check FAILS at least once, (b) a fix task
  is created, (c) **no task is `done` while a required check is failing**, (d) if
  it converges, the final report passes and the epic integrates.
- Keep fake-mode self-test green; real-LLM verifies convergence.

## 7. Slices (each: tsc + eslint + prettier + vitest, one commit)

1. **`verification.ts`** pure module: types, `verificationSpec`, `verifyWorkItem`
   (pure given injected check fns) + unit tests.
2. **DB + store**: `verification_reports` table, `insertVerification`,
   `listVerification`, `latestVerification` + tests.
3. **Wire the single chokepoint** in `runWorkItemInner`: replace the three inline
   gate blocks with `verifyWorkItem`; persist + emit; keep behavior parity for the
   passing path. Integration tests for pass/fail.
4. **Fix-task-on-failure + budget** (`ATEAM_MAX_FIX_ITER`, default 3) replacing
   restart→escalate for hard-check failures; escalate at cap. Integration test:
   constraint violation ⇒ fix task (not deadlock); at cap ⇒ escalation.
5. **Integration ∈ DoD**: forbid `review`/`done` without an integration record;
   "Skip" ⇒ recorded `skipped`. Test.
6. **API endpoint** + harness reads + new outcome fields + `gate-enforcement`
   scenario. Fake self-test.
7. **Docs/env**: `.env.example`, README, RUN-ISSUES resolution.
8. **Real-LLM eval** of `gate-enforcement` + a converging `headless` re-run.

## 8. Open questions for oracle

1. **Fix-task vs in-place restart for the SAME agent.** Creating a fix work item
   is auditable but adds board churn and a second clone. Alternative: keep the
   item `in_progress`, attach the failed report, and re-drive the same agent with
   the evidence injected (restart-with-context), only spawning a *separate* fix
   task at the escalation cap. Which is more robust against loops?
2. **Where should the constraint/build gate run — task clone or integrated epic
   tree?** Today build/constraint run in the task clone; QA runs in the epic
   clone. For a true "verify the integrated result", should ALL required checks
   re-run on the integrated epic tree at epic-finish, making per-task checks a
   fast pre-filter and the epic-level report the authority?
3. **Budget semantics.** Per-item fix rounds vs per-epic global budget vs both?
   The I8 review budget already exists at epic level — how to compose without
   double-counting?
4. **Backward-compat / migration.** Existing in-flight projects have no reports;
   the chokepoint must treat "no report yet" as "must verify now", never as pass.
5. Any determinism traps in reusing `runProjectBuild`/`runProjectTests` (timeouts,
   flaky suites) that would make the gate non-deterministic, and how to bound them.
```

---

## 9. REVISED per oracle critique (ORACLE-verification-gate.md) — binding

Prerequisite structural changes BEFORE wiring:
1. **Re-key recovery budgets `agent.id → workItemId`** (`restartedOnce` is agent-scoped today → cross-task premature escalation). Prerequisite for everything.
2. **No fix-task recursion.** Default recoverable path = **in-place re-drive of the SAME agent** with the failed report's evidence injected; persist a report each round (audit) under one per-item counter. Spawn a distinct fix *item* only at escalation/handoff. Never park the failed original in `review`.
3. **Authority split (Q2): task clone = fast pre-filter; integrated epic tree at epic-finish = merge authority.** Extend `finalizeEpic` with integrated constraints + integrated tests + ONE epic-level `GateReport`. Per-task reports attribute/pre-filter only.
4. **Collapse `epicBuildIter`+`epicAcceptIter`(+integrated constraints/tests) into ONE `epicRemediationIter` + a single remediation-in-flight latch.** Keep I8 review budget separate but mutually exclusive. Increment per failed REPORT, not per check. Cap total fix items per epic as backstop.
5. **`integrated` is a REQUIRED check** asserting a real integration commit/record; close the fall-through where a non-conflict integration failure or null `completion.hash` still reaches `review`.
6. **Four statuses: `pass`/`fail`/`skip`(n/a)/`error`(timeout/install/infra).** Only genuine `fail` consumes budget; `error` → one bounded retry then advisory. Keep `build`=`typecheck`. NO coverage% / docs-present / dep-audit in v1 (non-deterministic).
7. **Route every `moveItem(_,'done')` side-door (Skip/conflict/needs-input) + `forcedAccept` through the chokepoint or a recorded `skipped`/override report.**

---

## 10. IMPLEMENTED (2026-08-29)

- **Slice 1** (`verification.ts` + 11 unit tests) — pure model, 4 statuses.
- **Slice 2** (`verification_reports` table + store + `GET /workitems/:id/verification`
  + `GET /projects/:id/verification` + 1 integration test) — auditable trail.
- **Slice 3+4** (orchestrator wiring) — every gate decision persists a GateReport
  and emits a `verification` event; recovery budget re-keyed `agent.id → item.id`
  (`restartedForItem`); `integrated` is a required check that blocks review on a
  genuine integration failure; all Skip side-doors record an override report.
- **Slice 6** (harness) — asserts on persisted reports; `tasksDoneWithFailingGate`
  invariant; new `gate-enforcement` scenario (fake self-test passes 6/6, 10 reports).

Full suite: **168 passing**. tsc/eslint/prettier clean.

### Deferred (follow-ups, not blocking)
- Epic-level integrated authority report in `finalizeEpic` (Q2 authority split) +
  collapsing `epicBuildIter`/`epicAcceptIter` into one `epicRemediationIter`.
- A board/detail UI gate badge from the report.
- Real-LLM `gate-enforcement` convergence run.

### Real-LLM validation (gate-enforcement, 2026-08-29)
Ran the real SDK on an isolated instance. The framework worked end-to-end:
- Scoping (I1/I6): ux/frontend/researcher scoped out at decompose.
- The deterministic `produced` gate caught a **hallucinated completion** — the
  backend narrated "Committed as 9daa39b, src/store.js, confirmed green, pushing"
  while its task clone held only the `init` commit and NO source. Gate → produced:fail.
- Re-keyed per-item budget: restart-once, then escalated to a human question
  (Retry/Skip) instead of silently advancing.
- Auditable: two durable failed reports via GET /projects/:id/verification.
- Invariant held throughout: `tasksDoneWithFailingGate === 0` (parked, never
  terminal-with-failing-gate).
Conclusion: the gate refused to advance an empty/unverified delivery a trusting
Lead would previously have accepted on narration — the exact defect class fixed.

### Follow-up surfaced (separate issue)
Investigate WHY the backend's claimed git commit did not land in its run dir
(agent hallucinating tool results / committing in the wrong cwd). The gate guards
the symptom; the root cause is a separate reliability item.

### Root-cause fix: commit-aware work detection (2026-08-29)
The real-LLM run's `produced:fail` was NOT a hallucination - it was a genuine
orchestrator bug the gate correctly surfaced:

- **Cause:** `produced` = `git.hasRealChanges()` = `git status --porcelain` -
  UNCOMMITTED working-tree changes only. `commitWork` was the same. A capable
  real-SDK agent ran git ITSELF (create files -> `git add` -> `git commit` on the
  task branch, commit `9daa39b`), leaving a clean working tree. So the orchestrator
  concluded "produced no file changes", restarted, and re-cloned the task clone -
  which is why the post-mortem showed the local branch back at `init` while the
  real work survived only as `origin/ateam/task-* = 9daa39b`. Same class as the
  live "empty epic" symptom.
- **Fix (`git.ts`):** added `commitsAheadOfBase` (rev-list HEAD vs `origin/HEAD`
  fork point), `committedFilesAheadOfBase`, and `hasWorkToIntegrate` (dirty OR
  ahead). `commitWork` now credits an agent's own commit(s) - clean tree but ahead
  of base returns `{committed:true, hash:HEAD}` (no empty commit) so integration
  proceeds. Orchestrator's `produced` and the brownfield doc-only refinement are
  now commit-aware.
- **Tests:** `tests/unit/gitCommitAware.test.ts` (+2) - an agent that commits its
  own work is credited and integrates; the uncommitted path still works. Suite 170.
- **Note:** the recovered commit used `express` - so once it integrates, the
  constraint gate will (correctly) catch the dep violation on the real content,
  which is the intended layered behavior.

### Deferred slices Q2 + Q3 IMPLEMENTED (2026-08-31)
- **Q3 (budget collapse):** merged `epicBuildIter` + `epicAcceptIter` into ONE
  shared `epicRemediationIter` (cap `MAX_REMEDIATION_ITER=3`). A churning epic can
  no longer burn 2x the rounds by alternating build-fix and acceptance-fix before
  escalating. All delete/reset sites updated.
- **Q2 (epic-level integrated authority):** `finalizeEpic` now persists an
  epic-scoped GateReport (`scope:'epic'`, checks integrated-build /
  integrated-constraints / integrated-tests / acceptance) at every terminal merge
  decision - build-fail, constraint-fail, acceptance-fail, and the passing merge -
  plus an audited `overrideReport` on user "merge anyway". Added a NEW
  merge-authority **integrated-constraint gate**: `checkClone` re-scans the fully
  integrated epic tree (the authority; task-clone gate is only a pre-filter) so a
  violation that survived integration can't merge on narration - routed via
  `handleIntegratedConstraintFailure` (shares the remediation budget, then
  escalates). `integrated-tests` stays `skip` (owned by the per-task QA gate).
- **Tests:** +1 integration (a merged epic persists a passing epic-scoped report
  carrying integrated-build + acceptance). Suite 172 (171 pass, 1 skip).
