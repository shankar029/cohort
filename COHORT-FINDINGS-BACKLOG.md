# Cohort — Findings Backlog (from brownfield validation)

Consolidated, de-duplicated findings from Phase 0/1 + the cross-layer collaboration
scenario. **Grouped by theme** so related items can be fixed together AFTER Phase 2.
Status legend: `[ ]` open · `[~]` in progress · `[x]` fixed.

> Source runs: `LIVE-BROWNFIELD-PLAN.md` (Phase 1 project `prj_-h_RZvZe_LTf`;
> cross-layer project `prj_r4PhmYjBz4dz`). Fixture: `C:\Code\Projects\ateam-bf`.

---

## Group A — Repository-instruction ingestion (`src/server/agents/context.ts`)
- [x] **A1. Nested/per-package instruction files are ignored.** ✅ FIXED — `collectRepoInstructions()`
  now walks nested `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`/`CONVENTIONS.md`/`.cursorrules`/`.windsurfrules`
  (BFS, depth≤6, ≤60 files, ignores node_modules/.git/build/etc.). `packages/*/AGENTS.md` is injected.
- [x] **A2. Instruction truncation can silently drop rules.** ✅ FIXED — result now reports
  `truncatedFiles`/`droppedFiles`; the prompt appends a visible `⚠ …exceeded the context budget`
  note so agents know to open the file directly. Tests in `tests/unit/repoInstructions.test.ts`.

## Group B — Version control / commit conventions (`src/server/orchestrator.ts`)
- [x] **B1. Commit messages aren't Conventional-Commits.** ✅ FIXED — new
  `src/server/commitStyle.ts` centralizes every commit message; `ATEAM_COMMIT_STYLE=conventional`
  makes the harness emit `chore(merge): …`, `chore(sync)/(integrate): …`, and typed task commits
  (`fix|feat|docs|test|refactor|build(scope): …` inferred from title/stream). Default stays `ateam`
  (unchanged). `findEpicMergeCommit` grep kept in lockstep (verified git BRE matches literal parens).
  Tests in `tests/unit/commitStyle.test.ts`.

## Group C — Decomposition & role boundaries (`orchestrator.ts` decomposeEpic + prompts)
- [x] **C1. Cross-layer bugs get a single-owner task that under-covers.** ✅ FIXED — new pure
  `pickBrownfieldBuilders()` in `streamScope.ts`: single-owner for single-layer work
  (unchanged), but fans out per code layer when a request clearly spans ≥2 of
  {backend,frontend,ux,data}, each getting a `concrete: true` real-change task. Wired into
  the brownfield branch of `decomposeEpic` (emits a `Cross-layer scope — fanned out` event).
  +5 unit tests. Unit-proven; t3 was single-layer so it correctly did NOT fan out. Live
  cross-layer exercise still optional/pending.
- [x] **C2. Fuzzy role boundaries.** ✅ MITIGATED — verify task description now forbids editing
  production source (verify & report; tests/docs only; hand defects back). Safe now that C1
  assigns each code layer to a real owner. Live-observed QA review-fixes targeting TEST files
  (consistent). Residual: see Group G (QA "fix" task sign-off loop).

## Group D — Observability / auditability
- [x] **D1. Recordings not written under the real adapter.** ✅ RESOLVED — root cause was a
  harness/config omission, NOT a Cohort defect: the recorder (`runTurn` begin/end) is
  adapter-agnostic and only gated on `settings.recordSessions`, which the live runs never
  enabled. Added `ATEAM_RECORD_SESSIONS=1` to default recording ON for new projects
  (headless/live), threaded config→app→`createProjectWithLead`. Documented in `.env.example`.

## Group E — Repo hygiene (Cohort itself, pre-existing; not agent-caused)
- [x] **E1. `npm run lint` red at baseline** ✅ FIXED — was 104 errors, now **0**. Added an
  eslint override giving `scripts/**` + `evals/**` Node+browser globals, ignored `**/._*`
  scratch files, disabled `ban-ts-comment` for plain-JS scripts, removed one dead import.

## Group F — Epic convergence / orchestration robustness (`orchestrator.ts` manager loop + review)
- [x] **F1a. Idle-wedge stall — leaked run/park guards.** ✅ FIXED — `stallRecovery.ts`
  `planStallRecovery()` (pure, 8 unit tests incl. the exact t3 repro) + `watchForStall` now
  clears stale TASK `running`/`awaitingInput` guards when provably idle-stalled (agent idle past a
  5-min watchdog => hung/crashed turn), restarts the hung agent session, and re-drives — instead of
  only posting a diagnosis. **Live-verified negative:** during a 1h25m real-SDK t3 run with the
  agent legitimately `working`, recovery correctly did NOT false-fire (0 spurious events). On
  server restart the *originally-stalled* t3 project resumed to done/merged.
- [x] **F1b. Live-grind / non-convergence.** ✅ ADDRESSED. Two-part outcome:
  (1) **Review budget (converge-or-escalate)** — new pure `reviewBudgetDecision()`
  (`reviewBudget.ts`) bounds BOTH review rounds and cumulative fix volume; `runEpicReview`
  parks+asks the user when either is exceeded. `ATEAM_MAX_REVIEW_FIXES` (default 12).
  Unit-proven (6 tests); NOT triggered live because — see (2) — review converged via normal
  approval once the real blockers were fixed. It remains the safety net for genuinely
  non-convergent review.
  (2) **The ACTUAL cause of t3's non-convergence** was three separate bugs, now fixed (see
  Group G): two constraint-checker false positives that manufactured endless phantom rework,
  and a stall-mask that let one leaked run guard hide a permanent wedge. **t3 live re-verify
  now PASSES: converged, merged, acceptance met (15 rows), tests green.**

---

## Fix plan (after Phase 2)
1. **Group A together** (A1 nested discovery + A2 truncation) ✅ DONE.
2. **B1** ✅ DONE.  **D1, E1** ✅ DONE.  **F1a** (idle-wedge stall) ✅ DONE.
3. **F1b + C1/C2 together** — the remaining structural work, all in the manager loop + review
   decomposition + role prompts: cap review re-decomposition (converge-or-escalate), split
   multi-layer work across owners, tighten verify/review role permissions, and make nudges resume
   the plan. Re-run t3 AND the cross-layer scenario to verify.

Groups A/B/D/E and F1a are shipped; F1b+C are the remaining set.

---

## Group G — Surfaced during the F1b/C live re-verify (2026-09-02)
- [x] **G1. `no-external-deps` flags internal workspace packages.** ✅ FIXED. The constraint
  checker treated `@repo/*` monorepo imports as external deps → phantom violation → endless
  rework (blocked t3 live). Now collects every workspace package `name` (root + nested
  `package.json`) and excludes them from both manifest-deps and bare-import checks.
  `constraints.ts` + 2 unit tests. Live-validated (`honored no-external-deps`).
- [x] **G2. `IMPORT_RE` mis-reads quoted `import` string literals.** ✅ FIXED. A discriminant
  like `kind: 'import'` was parsed as a side-effect import, capturing following type text as a
  bogus specifier → phantom `no-external-deps` violation. Added a negative lookbehind, required
  whitespace for the side-effect form, and forbade newlines in a specifier. +2 unit tests.
- [x] **G3. Leaked run guard masks a stall (F1a blind spot).** ✅ FIXED. `watchForStall` reset
  the stall clock whenever `running.size>0`, so one hung/leaked guard made the manager believe
  work was progressing forever and recovery never fired (t3 wedged 7+ min, all agents idle,
  zero stall events). New pure `boardHasLiveWork()`: a run counts as progress only within its
  watchdog window. `stallRecovery.ts` + 4 unit tests.
- [ ] **G4. QA "fix" task sign-off loop (role confusion).** A review-fix task routed to QA is
  handled with verify/sign-off semantics ("QA cannot sign off") and loops on Retry, never
  reaching `review` — which blocks the epic from re-reviewing. Worked around live via "Skip".
  **Sev: Med.** *Fix idea:* frame review-fix tasks as "fix", not "verify", regardless of the
  target stream; or bound per-task sign-off retries and route to the owning builder.
- [ ] **G5. Agent made an out-of-scope destructive config edit that merged.** An agent dropped
  `packages/web` from the root `workspaces` array; it passed gates (web has no failing tests)
  and merged. **Sev: Low.** *Fix idea:* flag/deny edits to shared root config (`package.json`
  workspaces, tsconfig) outside a task's declared scope, or gate on a broader build.

## Group H — Interactive Team-Lead responsiveness (from live chat review, prj_5waL6eFxEi65)
- [x] **H1. Lead dead-ends idle after a failed/rejected/blocking tool call.** ✅ FIXED. When the
  user asked the Lead to "start the server / is it up?", the Lead reached for a shell tool, which
  the permission gate (`handlePermission`: `lead && kind!=='read' → reject`) rejected — and the
  SDK **ended the turn** with only the Lead's *preamble* as the answer. The Lead went idle and the
  user had to ping again (2–3×) before it explained. **Root cause:** the catalog's read-only
  allowlist for the Lead was never enforced at the SDK level (`realAdapter` only set
  `excludedTools:['sql']`), so the runtime still *offered* the Lead every write/shell tool; the
  prompt + permission gate said "no", the reject dead-ended the turn, and nothing re-drove it.
  **Fix (3 parts, +9 unit tests, live-verified):**
  (1) New pure `agents/toolPolicy.ts` `deniedBuiltinTools(role, tools)` — enforce the allowlist at
  the SDK via `excludedTools`; the Lead + read-only roles lose write + the whole `<verb>_<shell>`
  tool family (`read_powershell`, `list_powershell`, `write_bash`, …) while keeping
  `view/grep/glob/read_file`. (2) `onPermissionRequest` now rejects **with `feedback`** so any
  still-rejected tool feeds a reason back and the model can continue instead of stranding.
  (3) Lead prompt: if asked to run/start/verify, either give the exact command or delegate to a
  specialist and report back — always finish with a direct reply. **Live proof:** re-running the
  exact prompt, the Lead made **no** shell call, said it can't execute, inspected config via
  `view`, delegated to a verifier, and answered directly — turn completed normally.
- [x] **H2. No reliable boot-and-probe primitive (blocking start hangs the turn).** ✅ FIXED.
  When the Lead delegated "is the server up?" to a verifier, that specialist couldn't confirm it:
  running a server start (`npm start`/`node server.js`) is a BLOCKING command that never returns,
  so it hangs the tool call / turn (only the 15-min safety unwinds it), and agents had no way to
  background-start → probe → tear down. **Fix (+3 unit tests, offline-proven):** new pure
  `src/server/appProbe.ts` `probeApp()` — spawns the start command in the background, waits for
  readiness (`readyUrl` polled until it answers, or `readyCommand` until exit 0), runs
  `probeCommands` (e.g. `curl` checks) capturing output, then ALWAYS tears down the whole process
  tree (reuses `qaGate.killProcessTree`). Exposed as a `probe_app` SDK tool registered ONLY for
  shell-capable specialists (builders/QA) — the Lead and read-only roles never get it, preserving
  H1. Prompt guidance added: use `probe_app`, never run a blocking start command directly.
  *Live exercise (a specialist booting a delivered app) is the natural next validation — offline
  boot+probe+teardown, early-exit, and timeout paths are unit-proven.*
- [x] **H3. Lead's interactive one-off delegation bypasses the real team (and probe_app).**
  Discovered while live-testing H2: for an ad-hoc "verify this" request, the Lead delegates via
  the SDK built-in `task` tool, which spawns an ISOLATED sub-agent that does NOT carry ateam's
  custom tools (probe_app, board/chat tools) — so it reported "probe_app is not available" and the
  real backend/QA specialist (who has the tool) was never engaged. probe_app IS reachable in the
  normal delivery/QA path (real specialists in an epic clone), which is where boot-and-probe
  matters most; only the interactive one-off path is affected. **Sev: Med.** *Fix ideas:* exclude
  the built-in `task` tool for the Lead and give it a real "assign task to specialist" app-tool
  for ad-hoc work; or make sub-agents inherit the session's custom tools.
  ✅ FIXED (Fix A, live-proven). (1) toolPolicy excludes the built-in `task` sub-agent spawner for
  the Lead (SUBAGENT_TOOLS), so it can no longer spin isolated helpers that bypass the team. (2) New
  Lead-only `delegate_verification` app-tool: picks a shell-capable specialist (QA/backend), asks
  them to boot-and-probe via `probe_app` in the main checkout, and RESOLVES with their report so the
  Lead answers the user directly. Wired in realAdapter (lead-only), orchestrator.appToolsFor +
  pickVerifier(), adapter.AgentAppTools, and the Lead prompt. Live: Lead→delegate_verification→QA
  Engineer→probe_app→"booted and ready on localhost:3000"→Lead relayed.
  → GENERALIZED: `delegate_verification` replaced by a single general `delegate` tool (task +
  optional specialist/context) so the Lead can hand ANY ad-hoc, reporting-only work to the right
  specialist — verify/boot-probe, run tests, investigate, inspect data/logs, explain — not just an
  enumerated verb per need. Boundary enforced in the delegate prompt: deliverable/code changes are
  refused and redirected to the normal task/epic + review flow (no unreviewed mutation via the ad-hoc
  channel). pickVerifier→pickSpecialist. Live-proven twice: "is the app up?" (QA→probe_app) AND "run
  the test suite" (QA→npm test, exit 0), both relayed by the Lead. +1 toolPolicy test.
