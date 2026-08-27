# Delivering complex projects without compromise — required changes

**Scope:** everything the team (Team Lead + all specialists) needs so a genuinely
complex, multi-part project is delivered correct, complete, integrated, tested,
reviewed, and accepted — no stubs, no "docs instead of code", no half-finished
epics.

**Legend:** `[prompt]` = wording only (cheap) · `[code]` = orchestrator/store/gate
change · `[arch]` = structural/model change (largest) · **P1/P2/P3** = priority.

**Guiding principle — full traceability chain, nothing skipped:**
`requirement → design → interface contract → task(s) → code → tests → review →
acceptance`. No task closes without evidence; no epic merges without an
end‑to‑end acceptance check against the stated criteria.

---

## Level 1 — Intake & requirements (Lead + PM)

**Now:** PM posts free‑text acceptance criteria as a best‑effort annotation
*after* dispatch; nothing is persisted or linked.

- **P1 [code]** Persist acceptance criteria as first‑class records
  (`id, given/when/then, epicId, linked taskIds, linked testIds, status`) in a new
  `acceptance_criteria` store table.
- **P2 [code]** Large‑epic requirement confirmation: Lead posts scope + criteria
  and (respecting the project's manual‑approval/pause setting) can gate the build
  on user confirmation.
- **P1 [prompt]** PM emits criteria in a machine‑parseable block so they can be
  persisted and mapped to tests.

## Level 2 — Design & decomposition (Lead + Architect) — the core lever

**Now:** `decomposeEpic` does a **fixed mechanical fan‑out — exactly one task per
stream** (greenfield) or **one task total** (brownfield). The Architect's design
is posted to the thread but **never injected into task descriptions**; tasks are
generic templates ("deliver the X slice of goal"). Ordering is only
core → docs/devops → verifiers.

This is the single biggest limitation for complexity: a large feature is crammed
into one frontend task, one backend task, etc., with no interfaces and no
sub‑structure.

- **P1 [arch]** Two‑phase, **Architect‑driven structured decomposition**: the
  Architect returns a **structured plan** (JSON) = a list of tasks
  `{stream, title, description, dependsOn[], interfaces, acceptanceRefs}`; the Lead
  materializes exactly those as board tasks. Keep the mechanical fan‑out only as a
  fallback when the structured plan is empty/invalid.
- **P1 [arch]** **Multiple tasks per stream** (e.g. backend = schema, endpoints,
  validation; frontend = state, components, wiring) instead of one.
- **P1 [code]** A real **dependency DAG** (data → backend/contract → frontend;
  contracts before consumers), not just core→post→verify, so a consumer never
  starts before its producer landed.
- **P1 [code]** **Inject the Architect's design + the task's specific interface
  contract into each builder's task description/prompt** (today builders never see
  the design).
- **P2 [arch]** **Shared contract artifacts** (OpenAPI/JSON‑schema/shared types)
  written to the repo as a task output that downstream streams consume as the
  source of truth.

## Level 3 — Execution & per‑agent delivery

**Now:** `runWorkItem` runs one turn; an empty‑build gate retries then restarts the
session; the new capability‑scoped **delivery standard** prompt (no stubs,
integrate, run the build green) is in place. Per‑task verification only happens at
the epic‑level QA task; the "docs‑only" deliverable gate is **brownfield‑only**.

- **P1 [code]** **Per‑task verification gate**: after every *build* task, run
  typecheck + lint + scoped tests in the epic clone and block `task → review` on
  red — not just at the final QA task.
- **P2 [code]** **Multi‑turn continuation** for large tasks: iterate within a task
  (produce → self‑verify → continue) under a turn/time budget instead of one shot
  + empty‑retry.
- **P2 [code]** Extend the **"real code, not documentation"** deliverable gate to
  **all** build streams, not just brownfield.
- ✅ **[prompt] Done** — delivery standard added in `context.ts` (`1a50de1`).

## Level 4 — Cross‑stream integration & contracts

**Now:** intra‑epic siblings are serialized on one shared clone, but a later task's
prompt does **not** include earlier siblings' outputs; integration is implicit.

- **P1 [code]** Feed **prior sibling completion notes + changed files** into each
  subsequent task's prompt (they're already serialized, so later tasks can build
  on earlier ones deterministically).
- **P2 [arch]** A dedicated **integration task** at the end of the core streams
  that wires the modules together and runs the full build/E2E.
- **P2 [arch]** Contract file(s) (Level 2) as the enforced source of truth both
  sides implement against.

## Level 5 — Git isolation & parallelism model

**Now:** each **epic** gets an isolated clone on `ateam/epic-<id>`; **tasks within
an epic are serialized** (shared clone, `epicBusy`); different epics run in
parallel; merge `--no-ff` to base; no remote.

- **P2 [arch]** **Parallel intra‑epic execution**: per‑task branch off the epic
  branch, merged back — so independent streams in a complex epic actually run
  concurrently (already in `BACKLOG.md`).
- **P2 [code]** **Merge‑conflict detection + a resolver task** when a task branch
  can't merge cleanly back.
- **P2 [code]** **Refresh a task's checkout** from the epic branch before it starts
  so it builds on siblings' landed work.

## Level 6 — Testing & QA

**Now:** `qaGate.ts` detects the repo's test command and hard‑gates on exit code
in an isolated child process; QA persona owns E2E. No numeric coverage
enforcement; no criteria→test mapping; heavy installs run inline (crash risk,
partly mitigated).

- **P1 [code]** **Enforce a coverage threshold** (parse coverage output; fail below
  target).
- **P1 [code]** **Criteria → test traceability**: every acceptance criterion must
  map to ≥1 passing test; block sign‑off if any criterion is untested.
- **P2 [code]** **Out‑of‑process QA supervisor** so even a native abort in a heavy
  suite is contained (open `BACKLOG.md` item).
- **P2 [code]** Per‑project **build + lint + coverage** command config (extend the
  existing `testCommand` setting).

## Level 7 — Review & security

**Now:** the Architect reviews the PR diff and files routed comments; Lead‑gated
merge. Security/perf are advisory, not blocking; single reviewer.

- **P1 [code]** Make **security audit + code review BLOCKING** for complex epics:
  findings at/above a severity block the merge.
- **P1 [code]** **Routed review comments become fix tasks** that must be resolved
  (and re‑verified) before merge — enforce the loop, don't rely on a round count.

## Level 8 — Epic acceptance & merge

**Now:** merge fires when children are review/done and the review passes; a
completion report is posted. There's a **new prompt line** telling the Lead to
confirm end‑to‑end, but nothing enforces it.

- **P1 [code]** **Final acceptance gate before merge**: run the full build + E2E and
  verify every acceptance criterion has a passing test; block the merge otherwise
  (mechanical, not prompt‑only).

## Level 9 — Coordination / manager loop

**Now:** `leadTick` = assign → drive → close → supervise → stall‑watch; self‑healing
and deterministic. No re‑planning when work grows; no budget/burndown.

- **P2 [code]** **Re‑planning signal**: a task can emit "new work discovered" and
  the Lead creates follow‑up tasks (structured, not a chat aside).
- **P2 [code]** **Budget/burndown guardrails** (time/turns per epic) with
  escalation when exceeded.

## Level 10 — Prompts / personas

**Now:** personas are principal‑level; delivery standard added.

- **P1 [prompt]** Architect emits the **structured task/interface plan** (Level 2).
- **P1 [prompt]** PM emits **structured acceptance criteria** (Level 1).
- **P1 [prompt]** Builders **consume the injected design/contract** and must
  produce/honor contracts.

## Level 11 — Escalation / human‑in‑the‑loop

**Now:** `raiseQuestion` via the Lead; blocking questions could stall (mitigated by
moving planning after dispatch); **discard/revert epic** escape hatch shipped.

- **P2 [code]** **Batched decision checkpoints** instead of ad‑hoc mid‑task
  questions, each with a recommended default and a timeout → safe default.

## Level 12 — Observability / evidence

**Now:** events, usage, session recordings, PR diff/commits.

- **P2 [code]** Surface **per‑criterion status, test results, coverage, and review
  findings** per epic in the UI (the "proof" dashboard).

## Level 13 — Models

**Now:** `auto` per agent.

- **P3 [config]** Allow **stronger models for Architect / Reviewer / QA** on complex
  epics; keep `auto` as the default.

---

## Do‑these‑first (corrected sequence — after oracle review)

> An `oracle` second‑opinion pass corrected two priority inversions and re‑scoped
> the linchpin. The DAG engine (`dependsOn` gating in `assignUnassignedWork` /
> `driveAssignedWork`, backlog→todo cascade) **already exists** — the real gap was
> that builders never saw the design. So the linchpin is **design/interface
> injection at run time**, NOT "multiple tasks per stream" (which, without
> parallel‑intra‑epic, only adds latency + failure surface).

1. ✅ **Design/interface injection** — persist the Architect's design per epic and
   inject it into every builder's run prompt. *Invariant‑safe (enrich‑after, read
   at `basePrompt`), fake‑testable.* **SHIPPED** (this slice).
2. ✅ **Per‑task mechanical verification gate** — runs the repo's build/typecheck
   check (`typecheck` > `build` > `compile`, or a `buildCommand` override) in the
   epic clone after a build task; a task that leaves the code non‑compiling is
   blocked from `→ review` (restart‑once → park+ask, mirroring the QA gate).
   Enforced only for the LAST builder so a partially‑built epic can't false‑block.
   Script‑less projects are a graceful no‑op. **SHIPPED.**
3. **Persist structured requirements** (PM criteria as linked records).
4. **Criteria↔test traceability + final acceptance gate before merge** (unblocked
   by 3).
5. **Parallel intra‑epic** (per‑task branch → merge‑back + conflict handling) —
   this is what makes finer decomposition pay off, so it precedes granularity.
6. **Multiple tasks per stream / structured plan** — only after (5), and only once
   **task idempotency (stable per‑task slug)** + **DAG cycle/dangling‑ref
   validation** land (hard prerequisites: `decomposeEpic` is re‑entrant and keys
   reuse on one‑task‑per‑stream today).
7. Blocking review/security + enforced fix tasks; re‑planning + per‑epic budgets
   (promote earlier once decomposition gets finer — a single stuck slice otherwise
   strands the epic; token spend multiplies).

**Also promoted to load‑bearing (oracle):** the integration/full‑build gate (Level
4) catches semantic cross‑stream drift that git merge can't; per‑epic turn/time
budget must land *with* finer decomposition, not after.

## Original priority list (superseded by the corrected sequence above)

1. **Structured, Architect‑driven decomposition** — multiple tasks/stream + real
   dependency DAG + inject design/contract into tasks (Level 2). *The one change
   that most determines whether complex work is even possible.*
2. **Verification everywhere** — per‑task gate + criteria↔test traceability +
   final acceptance gate before merge (Levels 3, 6, 8).
3. **Parallel intra‑epic** via per‑task branches + conflict handling (Level 5).
4. **Blocking review + security + fix‑task resolution** (Level 7).
5. **Persist structured requirements + proof dashboard** (Levels 1, 12).
6. **Re‑planning + budgets** (Level 9).

## What already helps (shipped)
- **Per‑task build gate** — the repo's build/typecheck runs in the epic clone after
  each build task (last‑builder‑only to avoid partial‑epic false‑blocks); a red
  build can't reach review. `buildCommand` project setting + auto‑detect.
- **Design/interface injection** — Architect design persisted per epic
  (`epic_designs` table) and injected into every builder's run prompt — the first
  vertical slice of the linchpin.
- Delivery standard prompt (complete code, integrate, run green) — `1a50de1`.
- Dispatch‑before‑planning so a planning turn can't strand delegation — `597573c`.
- Discard/revert‑epic escape hatch — `57826ee`.
- QA hard‑gate on the real test command; brownfield "one concrete tested change"
  steer + docs‑only gate; per‑epic serialization; self‑healing manager loop.
