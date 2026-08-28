# Live-run issue log — URL Shortener epic (`prj_IUPzF5KUig-r`, epic `wi_2M_CnOjFBs3S`)

Real-SDK run to validate the delivery spine + the `f0912ad` fixes. Recording every
issue observed; fixes drafted **after** the run completes.

**Prompt (user-style):** small in-memory URL shortener, JS, only Node built-in
`http`, no external deps. Endpoints POST /shorten, GET /:code (302), GET
/api/stats/:code. Validate URLs, 400/404 JSON errors, collision-free codes, hit
counts. Plus a standalone client library. Backend owns server+store; QA writes an
integration test (node:test+http, ephemeral port); Docs writes README + curl
examples. Real PR + review before merge.

---

## ✅ Confirmed working (regression guards, keep)
- **Fix A** — `sql` built-in tool excluded: **0** sql calls this run (was rat-holing before).
- **Fix B** — dispatch decoupled from chat reply: epic decomposed into 10 items, Lead went `idle`.
- Real parallelism (4 concurrent agents), per-task isolated clones (slice 5a), Architect design published, PM acceptance criteria written, backend produced layered code + unit + integration tests.

---

## 🐞 Issues observed

### I1 — Indiscriminate stream fan-out (over-decomposition) — CRITICAL (was HIGH)
Headless HTTP API, but the team spawned **ux, frontend, researcher** tasks (one
task per *provisioned* builder, never scoped to the request).
- Evidence: UX produced `docs/url-shortener-ux-spec.md`; **Frontend built an entire
  React/TypeScript/Vite SPA** — inventing external runtime deps (React, Vite) that
  DIRECTLY violate the prompt's "no external dependencies / only Node built-in http"
  and the "in-memory" constraint.
- Escalation: frontend then couldn't stabilize — kept re-validating against the late
  design + realigning to backend's real `/api/links` contract, regressing
  100%→80%→20% and dragging **epic progress backwards 44%→42%→36%**. Because
  devops/docs + all verifiers depend on every core builder (incl. frontend), the
  irrelevant frontend stream **stalls the whole epic**.
- Impact: massive wasted work, spec-violating artifacts, and a real convergence stall.
- Root: `decomposeEpic` fan-out uses all builder specialists; no relevance scoping.
- Fix idea: Architect/Lead scope the relevant streams BEFORE fan-out (headless/
  backend-only ⇒ no ux/frontend); gate a stream on whether the request needs it.

### I2 — Spec drift not enforced by acceptance criteria — HIGH
Prompt hard-constraints ("in-memory", "only Node built-in http", "no external
deps", implicitly JS) were **not** encoded as acceptance criteria, so nothing
gates them.
- Drift observed in backend clone (`wi_CcdUnQxvMUn-`):
  - **File-persisted**, not pure in-memory — `LinkRepository` writes/renames `data/links.json`.
  - **TypeScript**, not JS — `typescript` + `tsx` + `typescript-eslint` devDeps + a `tsc` build step.
- PM criteria were behavioral only ("users can shorten/redirect/see stats"), missing the constraints.
- Impact: drift will merge unchallenged; "deliver without compromise" violated.
- Fix idea: PM/Architect must extract the request's HARD CONSTRAINTS (storage model, language/runtime, dependency policy, specified endpoints/contracts) into first-class acceptance criteria the final gate enforces.

### I3 — Integrated build/test gate runs in a clone with no `node_modules` — HIGH (was MEDIUM)
Backend chose a TS toolchain (`build: tsc`, `test: node --import tsx --test`). Agents
**self-install deps** in their own task clones (node_modules + package-lock present in
`wi_dy-_KUAnark3`, `wi_OTV4AOBxp8GT`), so per-task gates + researcher gates pass
("All executable gates now pass at 97.86% line coverage").
- BUT the **epic clone** (`wi_2M_CnOjFBs3S`) has **no `node_modules`** — only
  `package.json`/`package-lock.json` were integrated. `qaGate.runResolved` (src/server/qaGate.ts:125)
  spawns the resolved command directly and **never runs `npm install`**. So the
  **integrated build gate** (`npm run build` → `tsc`) and the QA test run execute in
  the epic clone with no installed devDeps → `tsc`/`tsx` not found → gate FAILS even
  though every task built cleanly.
- Confirmed mechanism; awaiting the live failure at `finalizeEpic`.
- Fix idea: before the integrated build/QA gate, if the (integrated) clone has a
  `package.json` with deps and no `node_modules`, run `npm install` (or `npm ci`)
  once; cache/reuse. Same for per-task gate consistency.

### I2 — Constraint enforcement: criteria are good, but review anchors on drifted code — HIGH
UPDATE: the PM criteria were actually STRONG — they DID encode the hard constraints:
- #9 "after a server restart, prior codes are unavailable **because in-memory**"
- #12 "inspect the **dependency manifest** and runtime imports" (no-external-deps)
- #10/#11 cover the standalone client library.
So capture is not the gap. The gaps:
- Backend's delivery VIOLATES #9 (it **file-persists** `data/links.json`) and arguably
  #12 (TS toolchain devDeps). OPEN QUESTION (watching): does the **acceptance gate**
  (`evaluateAcceptance` in `finalizeEpic`) actually FAIL the epic on #9/#12? No
  acceptance/integrated-build event has fired yet.
- The **peer review step reviews the team's drifted code, not the original request**:
  4 excellent line-level comments, but comment #2 HARDENS the file store ("reject
  persisted stores whose keys aren't unique") — doubling down on the in-memory
  violation; #1/#3 reinforce the phantom React UI. See I7.
- Fix idea: acceptance gate must be the hard enforcer of #9/#12; and the review
  prompt should check the diff against the ORIGINAL request + criteria, not just
  internal code quality.

### I6 — Read-only Researcher stream assigned a code-delivery task → empty-build loop — HIGH
The fan-out gave `researcher` (a read-only role) a "deliver REAL source changes WITH
tests" task. Researcher correctly refused ("The Researcher role is explicitly
read-only"), produced no files twice, tripped the empty-build repair loop, and got
restarted — pure wasted cycles.
- Evidence: `Produced no file changes (attempt 1/2 … 2/2)`, `"[researcher] url
  shortner" produced no code after 2 attempts - restarting`.
- Root: greenfield fan-out treats `researcher` as a builder stream, but its persona
  forbids writing code — a structural role/task-type mismatch (relative of I1).
- Fix idea: exclude non-implementing roles (researcher, and arguably pm/architect)
  from the code-delivery fan-out; if research is wanted, give it a read-only
  deliverable task, not a "write code" task.

### I7 — Review/verification anchors on the drifted implementation, not the request — HIGH
The reviewer + QA verify the code the team built (React SPA + file store + browser
E2E) rather than checking it against the user's ORIGINAL prompt. So spec violations
(in-memory, no external deps, no UI, JS-only) sail through review; the reviewer even
reinforces them (hardening the file store, asking for MORE browser E2E).
- Impact: the "independent review" can't catch "we built the wrong thing" — only
  "the thing we built has bugs." This is the core "deliver without compromise" gap.
- Fix idea: feed the ORIGINAL request + acceptance criteria into the review/QA
  prompts and require an explicit conformance check against them (esp. hard
  constraints), not just code-quality review.

### I4 — Concurrent-integration rework churn, amplified by I1 — MEDIUM (CONFIRMED)
Frontend regressed 100%→80% (epic 44%→42%): "Sibling integration materially changed
the target [files]; re-basing my slice." A sibling's integrate-back moved shared
files, forcing frontend to redo work.
- Root: per-task clones fork off the epic tip; when a sibling integrates, later
  siblings editing the same files must reconcile. For a headless API, frontend has
  no business touching backend files at all — so this churn is a direct cost of I1
  (irrelevant stream editing overlapping files).
- Impact: wasted cycles, slower convergence; not a correctness bug (integration is
  serialized + conflicts re-queue), but real inefficiency.
CONFIRMED: real merge conflict fired — `Integration conflict on ateam/task-wi_dy-_KUAnark3:
Auto-merging .gitignore` (siblings both scaffolded `.gitignore`). The slice-5b
conflict→re-queue path handled it; epic still converged.
- Fix idea: primarily fixed by I1 (don't spawn irrelevant streams). Secondarily,
  narrow each stream's file ownership so siblings don't overlap.

### I5 — Architect design lands AFTER builders start → re-validation churn — MEDIUM
Design injection is best-effort/late ("the first task may run without it"). Here the
Architect published the shared contract after backend/frontend had already built, so
builders re-validated against the newly-recorded design — rework that compounds I4.
- Root: fan-out dispatches builders immediately (good for throughput) but the design
  that pins shared interfaces isn't ready yet.
- Fix idea: for contract-consuming streams, wait for the (short, bounded) design turn
  or make the design a hard dependency of those tasks; keep independent tasks parallel.

---

## Timeline
- T0 — epic created, decomposed into 10 items (ux/frontend/backend/researcher + devops/docs deps + qa/reviewer/security verifiers). Lead idle. No sql.
- T1 — Architect design published; PM criteria written; ux task integrated (100%); backend 65%, frontend 60%, researcher 10%. Backend code = layered TS (app/errors/link-repository/link-service/server) + 2 tests. **I1, I2 recorded; I3 flagged.**
- T2 — epic 44%: backend→review, ux→review, researcher done (97.86% coverage), frontend 100%. Agents self-installed deps in task clones. Backend integrated into epic clone (app/errors/link-repository/link-service/server + tests + ux spec).
- T3 — frontend 100%→80%, epic 44%→42%: "sibling integration materially changed the target" — **I4 recorded**; **I3 upgraded HIGH** (epic clone has no node_modules; gate never installs). No sql calls throughout.
- T3 — frontend 100%→80%, epic 44%→42%: "sibling integration materially changed the target" — **I4 recorded**; **I3 upgraded HIGH** (epic clone has no node_modules; gate never installs). No sql calls throughout.
- T4 — frontend 20%, epic 36% (regressing). Frontend history reveals it built a full **React/Vite SPA** (external deps, spec violation) and is thrashing to realign to backend's `/api/links` contract + late design. **I1 upgraded CRITICAL** (irrelevant stream stalls epic); **I5 recorded** (late design churn). devops/docs/verifiers still blocked on the unstable core.
- T5 — all builders done; verifiers ran. **Reviewer filed 4 strong line-level fix comments** (focus/a11y, duplicate-key integrity, weak E2E, coverage-gate gap) → 4 fix tasks; PR `changes_requested`. **I3 did NOT bite** (epic clone acquired node_modules via a verifier/agent install — latent, not guaranteed). **I6 recorded** (researcher empty-build loop). **I7 recorded** (review anchors on drifted code, hardens the file store). Per-task build gates passed (`npm run typecheck`/`build`). No "Integrated build"/acceptance event yet. sql still 0.

### I8 — Over-built artifact drives a long, expensive review→fix loop — HIGH
Because the team over-built (I1: React SPA + browser-E2E + file store), the reviewer
keeps finding legitimate issues in that large *wrong* surface, spawning fresh fix
tasks each round. Epic progress oscillated (100→92→98→92%) across multiple review
rounds over ~50 min without reaching merge. The loop is high-quality but polishing
the wrong thing — cost is unbounded in proportion to how far the build drifted.
- Root: compounds I1 (scope) + I7 (review anchored on drifted code, not the request).
- Fix idea: scope streams up front (I1) so there's less wrong surface; anchor review
  on the original request + hard constraints (I7); consider a per-epic review-round
  budget that escalates to the user instead of looping indefinitely.

---

## Summary — issue inventory & fix priority

| # | Severity | Issue | Root | Proposed fix |
|---|----------|-------|------|--------------|
| I1 | CRITICAL | Indiscriminate stream fan-out (ux/frontend/researcher on a headless API; frontend built a React/Vite SPA) | `decomposeEpic` fans out to every provisioned builder | Scope relevant streams to the request before fan-out (Architect/Lead relevance gate) |
| I7 | HIGH | Review/QA anchor on the drifted code, not the original request | review/QA prompts see only the diff | Feed original request + acceptance criteria into review/QA; require explicit conformance check |
| I2 | HIGH | Constraints captured in criteria but not enforced at the gate | acceptance gate doesn't hard-fail on #9/#12 | Make acceptance gate the hard enforcer of hard constraints (in-memory, no-deps, endpoints) |
| I6 | HIGH | Read-only researcher assigned a code-delivery task → empty-build loop + restart | fan-out treats researcher as a builder | Exclude non-implementing roles from code fan-out |
| I8 | HIGH | Over-built artifact → long/expensive review-fix loop, no convergence | compounds I1+I7 | Fix I1/I7 + per-epic review-round budget that escalates to user |
| I3 | MED (latent) | Integrated build/QA gate runs in a clone with no `node_modules` | `runResolved` never `npm install`s | `npm install` in the integrated clone before the gate |
| I5 | MED | Architect design lands after builders start → re-validation churn | fan-out dispatches before design ready | Gate contract-consuming tasks on the (bounded) design turn |
| I4 | MED | Concurrent-integration rework churn + a real `.gitignore` conflict | siblings edit overlapping files | Mostly fixed by I1; narrow per-stream file ownership |

### Fix order (proposed)
1. **I1** (scope fan-out) — biggest lever; shrinks I4/I8 too.
2. **I6** (drop non-implementing roles from code fan-out) — same code path as I1.
3. **I7 + I2** (anchor review/QA/acceptance on the original request + hard-enforce constraints).
4. **I3** (install deps before the integrated gate) — small, isolated robustness fix.
5. **I5** (design-before-contract-consumers) — sequencing refinement.
6. **I8** (review-round budget) — safety net after I1/I7.
