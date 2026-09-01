# Live Run Monitor — Snippet Vault (`prj_WNvNtFPI8E9b`)

**Requirement:** self-contained full-stack "Snippet Vault" — Node stdlib HTTP REST API,
vanilla-JS frontend, `node --test` suite. Constraints: **no npm deps, in-memory only**.
**Started monitoring:** 2026-08-31 ~07:38 (real SDK run).

Legend: 🐛 bug · ⚠️ issue · 🌀 drift · ✅ working-as-intended observation

---

## Timeline

### 07:38 — baseline
- Epic `wi_CSZkCvttXXwd` decomposed into **8 streams**: ux, frontend, backend, devops,
  docs, qa, reviewer, security. Build streams (ux/frontend/backend/devops/docs) +
  verify streams (qa/reviewer/security).
- Architect + UX working; frontend/backend in_progress (p=10); rest backlog.
- PM narrating snippet schema `{id,title,body,tags[],createdAt}`. Reasonable.
- 0 verification reports yet, 0 PRs, 0 questions.

- 🌀 **DRIFT-1 (minor, watch):** requirement explicitly said "decompose into
  **backend / frontend / tests** streams", but the orchestrator fanned out to 8
  streams incl. `devops` + `security` for a zero-dependency, in-memory, stdlib-only
  toy. Extra build streams (devops/docs) add token cost and integration surface with
  little value here. Not incorrect (full team was added), but a scope-adherence drift
  worth flagging — the decomposer isn't right-sizing streams to the requirement.

---

### 07:42 — first gate reports
- UX task `wi_QXrlMa0SA9NF` → **review**, gate **passed**: `produced:pass` ("delivered
  changes"), `integrated:pass` ("landed on the epic branch"), `constraints:pass`
  (honored no-external-deps, in-memory). Frontend 70%, backend 10% (slow start).
- ✅ **CONFIRM-1:** commit-aware detection + task→epic integration + constraint gate
  all firing correctly on a real self-committed task. `integrated:pass` proves the
  empty-epic root-cause fix holds live.

### 07:46 — constraint gate fires (TRUE POSITIVES) + upstream drift exposed
- Gate FAILED both build tasks on `constraints`, re-driving them:
  - Frontend `wi_iV-FPWfZqziE`: used **react, react-dom, vite, vitest, eslint** —
    scaffolded a full React/Vite app despite "vanilla HTML/CSS/JS, no framework".
  - Backend `wi_NTGh7ee89XVa`: used **express, zod, vitest** AND **persisted state to
    disk** (`backend/src/repository.ts`) — violates both no-deps and in-memory.
- Both correctly flagged `no-external-deps` + `in-memory`, tasks reset to in_progress
  and re-driven. `tasksDoneWithFailingGate` still 0 (nothing advanced on a failure).
- ✅ **CONFIRM-2:** constraint gate is a **true positive** on real drift — exactly the
  defect class the framework targets. A trusting Lead would previously have shipped a
  React+Express app that ignored every hard constraint.

## Confirmed issues
- 🌀 **DRIFT-2 [MITIGATED 2026-08-31]:** specialist agents **ignore explicit hard constraints
  on the first attempt**, defaulting to their familiar stacks (Frontend→React/Vite,
  Backend→Express/Zod/Vitest, disk persistence) even though the prompt said vanilla
  JS / stdlib-only / in-memory. The gate catches it, but each miss costs a full
  re-drive cycle (tokens + latency). Root cause: constraints aren't propagated
  forcefully enough into the per-task agent brief (they scaffold defaults before
  reading the constraint). **Fix candidate:** inject the derived constraints as
  prominent, imperative directives at the top of each task prompt ("MUST NOT add any
  npm dependency; MUST use Node stdlib + node --test; MUST keep all state in memory")
  and/or have the decomposer bake constraints into each task's acceptance criteria.
  Watching whether the re-drive now complies.

## Working-as-intended confirmations
- CONFIRM-1 (07:42): produced/integrated/constraints gate passed on real UX task.
- CONFIRM-2 (07:46): constraint gate true-positive on React/Express/disk drift.
- CONFIRM-3 (07:50): **gate → re-drive → recovery** works. After the constraint fail,
  both tasks re-drove to compliant stdlib/in-memory code: backend `produced:pass +
  integrated:pass` (3-report history fail→pass), frontend `constraints:pass`. The
  shared remediation loop recovered without human intervention and nothing advanced
  on a failing gate (`tasksDoneWithFailingGate` held 0 throughout).
- CONFIRM-4 (08:00): **~~end-to-end faithful delivery~~ — RETRACTED, see MAJOR-1.**
  All 8 tasks + epic reached review with every deterministic gate green and
  `npm test` = 43/0 — but at 08:03 the Lead's reviewer proved that green was a
  **false signal**: the tests encoded the agents' own (wrong) API contract. The
  deterministic layer was faithful to the *code*, not the *requirement*.

## MAJOR findings (08:03)

- 🔥 **MAJOR-1 (headline): deterministic gates cannot catch contract drift; the LLM
  reviewer can — and did.** On PR review the Code-Reviewer filed **12 specific,
  file/line-cited BLOCKING defects** and spawned fix-tasks. The delivery passed every
  deterministic gate (produced/integrated/constraints/tests) yet did **not** meet the
  requirement:
  - **Smoking gun (QA):** the integration + e2e tests POST `content` and assert
    `{snippet}`/`{snippets}` envelopes — the agents wrote tests for their *own* API,
    so `npm test` passes while the required `{title,body,tags[]}` payload and **array**
    list response are unmet. **Green tests validated the implementation, not the spec.**
  - Backend stores/validates `input.content`; a valid `{body}` request gets 400
    (`Content is required`) — required payload contract not implemented.
  - `GET /api/snippets` returns `{snippets:[...]}` not a JSON array (criteria 9/11).
  - No runnable entry point / `start` script; server doesn't serve the frontend.
  - Frontend live search filters a local array instead of calling
    `GET /api/snippets?q=` (criterion 4 unmet); "newest first" sorts on `updatedAt`;
    body is `trim()`-ed on save (corrupts code); e2e never loads `index.html`.
  - Frontend a11y/UX: `root.innerHTML` reset on every keystroke destroys input focus.
  - ✅ **Macro-level orchestration worked as intended:** it did NOT ship a non-compliant
    deliverable on green gates + narration — the review→comment→remediation loop caught
    it and generated targeted fix-tasks (now in_progress).
  - ⚠️ **Escalates ISSUE-1:** the deterministic gate has **no contract/acceptance check**
    tying delivered API shape to the spec, and the `tests` check (even when run) is
    defeated by self-referential tests. **Fix candidates:** (a) derive a machine-
    checkable acceptance probe from the requirement's explicit criteria (POST `{body}`
    → expect 201; `GET` → expect array) and run it as a REQUIRED epic-level check;
    (b) treat agent-authored tests as necessary-not-sufficient, paired with a
    spec-derived contract test the agents don't author.

- ⏳ **Remediation loop now running** — watching whether the shared `epicRemediationIter`
  budget converges the 12 fixes or exhausts and escalates to the user.

## Findings (08:27) — escalation + a real API bug

- ✅ **CONFIRM-5: escalation-not-silent works under real stress.** The remediation loop
  churned ~10 of 12 fixes to green, then hit two genuinely hard ones and **escalated
  to the user instead of silently passing** (QA Engineer → `needs_input`, 2 open
  questions, nothing advanced on a failing gate):
  - `qst_wDXV_wlhqlhB` (backend payload fix): **sibling integration conflict** on
    merge “even after a retry” — integration-conflict detection + budget exhaustion →
    human. Correct.
  - `qst_s2wdG5jmQGpH` (qa test fix): “`npm run test:e2e --silent` still failing after a
    session restart — how to proceed?” Correct: the deterministic `tests` gate refused
    QA sign-off and, after the budget, punted to the human.

- 🌀 **DRIFT-4 (reviewer vs. constraints):** one fix demand — `wi_xOVTlrROqYJe` “e2e never
  runs the frontend; add a genuine browser e2e that loads index.html” — is hard/
  infeasible under the **no-npm-deps** hard constraint (a real browser/DOM e2e needs a
  headless browser or jsdom = a dependency). The reviewer generates demands without
  reconciling them against the frozen hard constraints, which can manufacture an
  unsatisfiable fix loop. Here it correctly ended at a human question, but the
  reviewer should be constraint-aware (or the Lead should reconcile) before spawning
  such a fix. This is the `test:e2e` failure feeding `qst_s2wdG5jmQGpH`.

- 🐛 **BUG-2 [FIXED 2026-08-31 — commit after `6d75ff9`]: the events feed returned the OLDEST
  events and ignored `limit`.** `store.listEvents` (`store.ts`) used
  `ORDER BY created_at ASC LIMIT ?` and the route (`app.ts:635`) never forwards the
  `?limit=` query param (defaults to 500). Verified live: `events?limit=200|1000|3000`
  ALL return `count=500, newest=07:45` while the run is at 08:27. Impact: once a
  project exceeds 500 events the **Activity page freezes** on the oldest window and
  never shows recent activity. **Fix:** `ORDER BY created_at DESC LIMIT ?` (reverse for
  chronological display) + read & pass `limit` in the route (clamp to a max). Not fixed
  now because editing `src/server/*` restarts the `tsx watch` backend and would kill
  the in-flight epic. Queued for after the run.

- 🐛 **BUG-3 [FIXED 2026-08-31 — commit after `6d75ff9`]: “Need Your Input” offered no custom answer.** The
  escalation UI only exposes **Retry** / **Skip this task** buttons — there's no free-
  text field to actually answer the agent's question (e.g. tell backend which contract
  wins, or tell QA to use stdlib-http e2e). Since these escalations are literally
  “How should we proceed?” free-form questions, the two canned buttons can't convey the
  needed guidance, so a human is forced to Skip (drops the fix) or Retry (re-runs the
  same failing loop). **Fix:** add a text input to the Need-Your-Input card that POSTs
  to `/api/questions/:id/answer {answer}` (the backend already accepts free text — I'm
  using it now via API); keep Retry/Skip as quick presets. Verified the API path works
  as the workaround.

### 08:33 — answered both escalations via API, run resumed
- `qst_wDXV_wlhqlhB` → told backend the `{title,body,tags[]}` + array contract is
  authoritative and wins; rebase onto current epic branch and re-apply over sibling.
- `qst_s2wdG5jmQGpH` → told QA to satisfy criterion 4 with a **stdlib-only** e2e (real
  server on ephemeral port + `node:http` CRUD/search/delete + assert `/` serves
  index.html with the controls) — no browser/jsdom dep.
- Both consumed (`ok:true`); open questions → 0; Backend + QA back to `working`.
  Continuing to monitor convergence to merge.

## More findings (08:00)

- ⚠️ **ISSUE-1 (REFINED at 08:21 — downgraded):** deterministic `build`/`tests` checks
  are **stream-conditional**, not universal. Build-stream tasks skipped them, but the
  **QA fix task DID run `tests` deterministically** (`npm run test:e2e --silent`) and
  **correctly FAILED** it (2 failed reports, re-driving) — so the gate does execute and
  enforce tests where it matters. Remaining nit: build-stream integrating tasks don't
  run the available `build`/`test` script, so a compile/test break in a non-QA slice
  wouldn't be caught until the QA stream. Still worth running build on the integrating
  task, but this is minor — the QA stream is the deterministic test backstop.

- ℹ️ **OBSERVATION (not a bug):** epic-scoped merge-authority report count = 0 —
  expected. `finalizeEpic` fires at MERGE (Lead-gated); epic parked in `review` with
  an open PR. (Superseded anyway — the epic went back to build via MAJOR-1 fixes.)

### 09:43 — near-converged; one FALSE gate failure blocks merge
- Integrated tree fully remediated: **`npm test` = 60/60**, `test:e2e` = 2/2, and the
  smoking-gun `snippet-api.test.js` now uses the required `{title,body,tags[]}` + array
  contract (`"content" in created === false`, no-match `[]`, delete→404). **MAJOR-1 is
  resolved in the merged result.** 11/12 fixes in review; only `wi_GXEBvN8ixuhP` still
  `task:failed` (4 reports) and it re-escalated.

- MAJOR-2 [FIXED 2026-08-31]: **task-clone gate yields FALSE NEGATIVES for interdependent fix-tasks.**
  `wi_GXEBvN8ixuhP` (rewrite tests to the correct contract) runs `npm run test:e2e` in
  its ISOLATED task clone, which does NOT contain the sibling backend payload fix
  (`wi_rCDRVtUuBVCF`, integrated as `81edc7f`). Its correct, contract-aligned tests
  fail against the clone's stale backend — a FALSE failure. Proven: the INTEGRATED
  epic tree with the same tests passes 60/60 + e2e 2/2. The clone-as-pre-filter can't
  see sibling changes, so a test-contract fix that depends on a code-contract fix will
  loop/re-drive/escalate forever even though merging is correct. Contradicts the
  intended "integrated tree = authority" principle for this case.
  Fix candidates: (a) for review-remediation fix-tasks, run the failing check against
  the INTEGRATED epic tree (authority) before re-driving/escalating; (b) add dependency
  edges so a test-alignment fix is sequenced AFTER the code fix it asserts; (c) when
  the integrated tree passes, auto-resolve a sibling's false-fail instead of escalating.
  Net impact: an otherwise-perfect epic wedged in `review` on a phantom failure.

- 09:44 — answered `qst_QN6-qG4lkloK` via API: objective already satisfied in the
  integrated tree (60/60); failure is a stale-clone false negative; SKIP/close and
  finalize. Watching whether the orchestrator honors a free-text "skip".

### 09:52 — reviewer opens a SECOND remediation wave (5 more tasks)
- Free-text "skip" answer worked: `wi_GXEBvN8ixuhP` → review/passed, PR briefly `open`.
  Then a 2nd review pass reopened `changes_requested`, epic→85%, 26 workitems total.
- Wave-2 mix:
  - Legit edge-cases: equal-timestamp tie not reliably newest-first
    (`snippet-service.js:57-61` random-UUID tiebreak); ordering unit test codifies
    wrong tie; README still says `updatedAt` (doc drift).
  - Scope-policing: remove unrequested `PUT /api/snippets` mutation endpoint; remove
    unrequested edit + clipboard-copy UI from the frontend.

- 🌀 **DRIFT-5 [MITIGATED 2026-08-31]:** agents built MORE than requested (a `PUT`
  update endpoint, inline edit, clipboard-copy) beyond the spec's list/create/search/
  delete. The reviewer then demands removal, so the team pays twice (build extra →
  flag → remove extra). Both the builder (adds scope) and reviewer (polices scope) are
  individually reasonable but together churn tokens/time. Root: no explicit
  "implement EXACTLY the listed endpoints/features, nothing more" directive in the
  task brief, and the builder optimizes for "impressive" over "to-spec".

- ℹ️ **OBSERVATION (review-loop iteration):** the review→remediation cycle runs
  MULTIPLE waves; later waves shift from correctness (contract) to scope-policing
  (nits/feature-trimming). Watching whether `MAX_REMEDIATION_ITER=3` caps this before
  it churns indefinitely, or whether cosmetic nits can keep an otherwise-mergeable
  epic (60/60 tests, contract correct) in review. Potential unbounded-nit risk.

### 09:57 — wave-2 converging; recurring integration-conflict escalations
- 🌀 **ISSUE-2 [MITIGATED 2026-08-31]: concurrent fix-tasks on overlapping files → integration
  conflicts → human escalation.** Twice now (`wi_rCDRVtUuBVCF` in wave-1,
  `wi_ZEvrgKcXNmLt` in wave-2) a fix conflicted with a sibling "even after a retry"
  because both edited the same backend files (`snippet-service.js`/`snippet-http.js`).
  The decomposer fans out parallel fixes touching the same files with no
  serialization, so merges collide and punt to the user. **Fix candidates:** group
  same-file fixes into one task/agent, or add mutual-exclusion/sequencing so
  overlapping-file fixes integrate serially; auto-rebase-and-retry before escalating.
- 09:58 — answered `qst_PcrTyal_97BR` via API (rebase, keep both changes, remove PUT +
  keep tie-ordering). This is the 4th human answer this run — all 4 were either
  false-negatives (stale clone) or same-file integration conflicts, i.e. orchestration
  mechanics, NOT product ambiguity. A fully autonomous run would have stalled here.

### 10:10 — remediation budget CAP fires (Q3 validated)
- ✅ **CONFIRM-6: `MAX_REMEDIATION_ITER=3` shared budget caps churn + escalates with a
  merge decision.** After 3 review rounds the Lead asked: "Epic still has 2 open review
  comment(s) after 3 rounds … Merge anyway, or keep working?" — exactly the Q3 design
  (one shared remediation budget, then a human merge/keep decision). The 2 remainders
  are minor UX edge-cases (create while a live-search filter is active + its missing
  test), not contract/build/constraint failures; core is correct (60/60 tests).
- Decision (validation run): answered **"merge anyway"** to exercise the last
  unvalidated path — `finalizeEpic` → epic-level merge-authority gate (Q2:
  integrated-build + integrated-constraints re-scan + acceptance) + audited
  `forcedAccept` override + merge + epic-scoped report. The 2 nits are logged as real
  deferrals (DEFER-1: create-under-active-search invariant + coverage).

### 10:11 — EPIC MERGED ✅ (run complete)
- Epic → **done**, PR `pr_oPssqAqCJxH-` → **merged**. Real repo `C:\Code\Projects\Snippet
  Vault` on `master`: merge commit `0eaf9b0`, **deps {} / devDeps {}**, **npm test =
  64/64 pass**. Delivered product meets the constraints and the required contract.
- ✅ **CONFIRM-7 (Q2 override path):** `finalizeEpic` recorded an epic-scoped report
  `outcome=skipped, passed=false, override:"user chose to merge despite unmet epic
  gates"` — the audited `forcedAccept` override, exactly as designed. (Because I chose
  merge-anyway, the epic gate short-circuited to the audited override rather than a
  clean pass; both are valid Q2 branches — the override branch is now validated live.)
- **DEFER-1 (real, minor, shipped as known-open):** create-while-active-search-filter
  invariant in `src/app.js` + missing coverage. Non-blocking UX edge-case.

---

## FINAL SUMMARY — what this run proved

**Total: 4 human answers, all orchestration-mechanics (0 product-ambiguity). 2 review
waves + a 3rd-round budget cap. Final: merged, 64/64 tests, 0 deps, correct contract.**

### ✅ Validated (our fixes work live)
| # | Capability | Evidence |
|---|---|---|
| CONFIRM-1/3 | Commit-aware detection + integrate + re-drive recovery | every task self-committed, `integrated:pass`; constraint re-drive → compliant |
| CONFIRM-2 | Constraint gate true-positive | caught React+Vite / express+zod+disk; forced stdlib/in-memory |
| CONFIRM-5 | Escalation-not-silent | budget/conflict → human Qs; `tasksDoneWithFailingGate`=0 all run |
| CONFIRM-6 | Q3 shared remediation budget cap | "2 comments after 3 rounds → merge anyway?" |
| CONFIRM-7 | Q2 epic authority report + audited override | epic-scoped `skipped` override recorded at merge |
| — | Review→comments→remediation | 12 cited defects wave-1 caught a spec-noncompliant delivery |

### 🐛 / 🌀 Issues to fix (priority order)
1. **MAJOR-1** — ✅ FIXED (this batch): deterministic, spec-derived ACCEPTANCE
   PROBE added as a REQUIRED epic-level gate, independent of the agents' own unit
   tests (which can pass a wrong contract). Resolution: project `acceptanceCommand`
   override → committed `.ateam/acceptance.mjs` (authored from the spec by the
   QA/architect during epic setup) → else skip. `qaGate.runAcceptanceProbe` runs it
   in the integrated epic clone at finalize; exit non-zero BLOCKS merge and routes
   back as fix work (`handleFailedAcceptanceProbe`, shared remediation budget, then
   escalate). Recorded as an `acceptance-probe` check on the epic GateReport and
   surfaced in the board verification panel. Tests: qaGate unit (pass/fail/absent),
   verification unit (required list), delivery integration (blocks on fail / passes
   on pass / records the check), eval `acceptance-probe --fake`, e2e panel assertion.
2. **MAJOR-2** — ✅ FIXED (`907878c`): pre-gate `refreshTaskFromEpic` syncs the task
   clone with integrated sibling work before the deterministic gates.
3. **ISSUE-2** — ✅ MITIGATED (`907878c` refresh + `09ccb4e` budget): re-drives fork
   off the fresh tip and sync siblings in; conflict budget raised so only genuine
   same-region conflicts escalate.
4. **BUG-2** — ✅ FIXED (`6723682`): newest-window + `?limit=` forwarded.
5. **BUG-3** — ✅ FIXED (`6723682`): free-text answer box on every question card.
6. **DRIFT-2** — ✅ MITIGATED (`3814e45`): imperative hard-constraint directives at
   the top of the task brief.
7. **DRIFT-5** — ✅ MITIGATED (`3814e45`): "implement EXACTLY the checklist, nothing
   more" scope-discipline directive.
8. **DRIFT-1/3 / ISSUE-1** — ✅ WON'T-FIX (intentional, documented) — (a) DRIFT-1
   over-fan-out: dropping `devops` for a self-contained headless toy was prototyped
   but REVERTED — `streamScope.test.ts` deliberately asserts devops is KEPT for the
   in-memory/no-deps case (it can still add run scripts/CI value), so this is a
   judgment call, not a bug; the headless eval already scopes ux/frontend/researcher
   out. (b) ISSUE-1: the per-task build gate already runs on builder streams and the
   integrated-build gate runs at epic finalize, with the QA stream + the new MAJOR-1
   acceptance-probe as additional epic-level backstops — the remaining nit is covered.
9. **DRIFT-4** — ✅ MITIGATED (this batch): the reviewer prompt now surfaces the
   epic's hard constraints (via `describeConstraints`) and explicitly forbids
   requesting changes that would VIOLATE one (no demanding a dependency, a
   datastore, or a UI the request forbids).

---

## Real-SDK validation run #2 — MAJOR-1 acceptance probe (`prj_jL1bsNFFDDHH`, 2026-09-01)

**Brief:** headless in-memory URL shortener, Node built-in `http` only, no external
deps, exact contract (`POST /shorten`→201 `{code,shortUrl}`, `GET /:code`→302,
`GET /api/stats/:code`→200 `{code,url,hits}`, 400/404 paths). Team:
architect/backend/qa/reviewer. `acceptanceCommand` deliberately UNSET so the system
authored the probe from the spec (the real MAJOR-1 path).

**What happened (end to end):**
- Decomposition right-sized to **backend / qa / reviewer** (headless ⇒ no UI streams;
  architect scoped out as non-implementing). ✅
- QA **authored a spec-derived probe** `.ateam/acceptance.mjs` (16 black-box contract
  assertions), self-verified it "15/15 against a reference impl", committed it to the
  epic branch (`b00ce03`). ✅ Independent of the builders' own unit tests.
- Reviewer (Architect) caught **5 real contract deviations** across 3 review rounds
  (creation contract, stats/hit counting, redirect/stats preservation, an extra API
  surface it forbade, code/route collision), then hit the review-round cap and
  **escalated** ("Keep working / Merge anyway"). Answered **Keep working**.
- After the fixes, **finalize ran the deterministic probe** on the integrated tree:
  - **08:59:54 → epic report `acceptance-probe: fail`** — BLOCKED the merge, routed a
    `fix: acceptance probe failing` task. (Independent of green review + green tests.)
  - Backend fixed the **deliverable** (added `"main": "src/server.js"`), NOT the probe
    (`.ateam/acceptance.mjs` untouched — the "do not weaken the probe" directive held).
  - **09:01:25 → epic report `acceptance-probe: pass`** → merged (`f3ca8df`).
- Independent re-run of the committed probe on the merged tree: **16/16 pass, exit 0**
  (POST→201, 400s, GET→302 w/ correct Location, stats hits=2, 404s, in-memory-on-restart,
  zero deps). ✅

**Verdict:** MAJOR-1 fully validated in real SDK — the probe is a REQUIRED epic gate
that is authored from the spec, survives integration, FAILS independently of the
builders' tests/review, BLOCKS merge, routes a fix, and gates the merge on pass.

### New findings from run #2
- 🌀 **PROBE-1 (minor, FIXED this batch):** the QA-authored probe first failed with
  Windows `spawn EINVAL` because it launched the app via the npm "start" script
  (`spawn('npm', …)` is not Windows-safe). The fix loop self-corrected (added a `main`
  entry so the probe spawned `node <entry>` directly). Hardened the **probe-authoring
  prompt** to require cross-platform launch (prefer `node <entryFile>`; use
  `{ shell:true }` if spawning npm/.cmd) so future probes are Windows-safe first time.
- ⚠️ **OVERRIDE-1 (design, OPEN — needs decision):** `forcedAccept` ("Merge anyway"
  after the **review-comment** escalation) short-circuits the ENTIRE `finalizeEpic`
  (orchestrator.ts ~3521), so it also **skips the deterministic acceptance probe** —
  re-opening the MAJOR-1 blind spot via the force-merge door. The subjective gates
  (LLM review/criteria) and the objective gates (integrated build/constraints/probe)
  should be treated differently: waiving review NITS should NOT waive an unrun,
  objective contract probe. **Recommendation:** in the review-escalation "merge anyway"
  path, resolve the review comments but fall through the normal finalize gates (so the
  probe still runs); keep `forcedAccept` bypass only for the escalation that is ABOUT
  that specific objective gate (where the user was explicitly shown it failing). Needs
  its own focused change + tests (+ ideally a re-run), so parked for a decision.
- ℹ️ **MAJOR-2 / ISSUE-2 NOT exercised:** single implementing stream (backend) ⇒ no
  concurrent same-file writes, so 0 sync/conflict events. A multi-builder epic with
  overlapping files is still needed to exercise the stale-clone refresh + conflict
  budget under a genuine race.
