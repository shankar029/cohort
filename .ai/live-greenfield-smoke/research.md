# Phase-1 Research — Live Greenfield Smoke (real Copilot adapter, design-first proof)

Repo: `C:/code/projects/cohort` · Branch: `feat/live-greenfield-smoke`
Stack: Fastify + React + TypeScript + better-sqlite3 ("Cohort" / package name `ateam`).
Claim types: **FACT** (verified in source, file:line), **INFERENCE** (derived from FACT), **HYPOTHESIS** (plausible, unverified), **UNKNOWN**.

## TL;DR — the seam map already exists
There is a shipped, opt-in, isolated **live harness** under `evals/` (`evals/harness.mjs` + `evals/run.mjs`) that boots the **real** adapter against a **greenfield** repo over HTTP/WS and scores deliverables. The bulletproof run should extend this, not build a new driver. The two behaviors under test have concrete, server-authoritative signals:
- **AC4 (FE produced real files):** git-diff on the frontend task/epic clone + merged default branch (`EvalHarness.collectDeliverables()`), cross-checked with a `frontend`-stream task reaching `review`/`done` and its `git` "Committed … files" event.
- **AC5 (design persisted before builders act):** the `epic_designs` row (`store.setEpicDesign`), written by `orchestrator.designThenEnrich` **before** task dispatch churns, plus the `<!--design-acceptance-->` marker appended to child-task descriptions (HTTP-visible).

---

## 1. How to boot headlessly with the real adapter

**FACT — Adapter selection is env-gated.** `src/server/config.ts:44`:
```
fakeSdk: env.ATEAM_FAKE_SDK === '1' || env.NODE_ENV === 'test',
```
`src/server/index.ts:36-38`:
```
const adapter: CopilotAdapter = config.fakeSdk
  ? new FakeCopilotAdapter()
  : new RealCopilotAdapter();
```
So in a normal (non-`test`) env with `ATEAM_FAKE_SDK` unset/`0`, the process wires the **RealCopilotAdapter**.

**FACT — There is NO exported `createApp/buildServer` factory in `index.ts`.** `main()` is a private async function that ends the module; it is invoked at import time via `main().catch(...)` (`src/server/index.ts:130`). Importing `index.ts` **starts a server** as a side effect; it cannot be called as a factory.

**FACT — `buildApp(ctx)` IS an importable factory.** `src/server/app.ts:112` exports `buildApp(ctx: AppContext): FastifyInstance`, and `AppContext` (`app.ts:23-30`) takes `{ store, bus, orchestrators, recorder, config, listModels }`. The orchestrator gets its adapter via `OrchestratorManager({ ..., adapter })` (`src/server/orchestrator.ts` `Deps.adapter`; constructed in `index.ts:39-46` and in `tests/helpers/testApp.ts:41-49`).

**FACT — A driver CAN construct `new RealCopilotAdapter()` explicitly.** `tests/helpers/testApp.ts:33` already supports `createTestApp(homeRoots, adapterOverride?)` and passes the override straight into `OrchestratorManager`. Nothing forces the fake except the default `adapterOverride ?? new FakeCopilotAdapter()`. So in-process, `createTestApp([], new RealCopilotAdapter())` would run the real SDK.
- **CAVEAT (FACT):** `testApp.ts:34` opens `openDatabase(':memory:')` — an in-memory DB, fine for assertions but not a durable artifact.

**RECOMMENDATION (INFERENCE):** Prefer the **spawn-the-built-server** path the evals harness already uses — it is the shipped, proven configuration and exercises the exact `index.ts` boot the product ships. `evals/harness.mjs:~112-120`:
```
this.child = spawn(process.execPath,
  ['--import', 'tsx', path.join('src','server','index.ts')],
  { cwd: REPO_ROOT, env, stdio: ['ignore', logFd, logFd] });
```
with env (`harness.mjs:104-113`): `ATEAM_PORT`, `ATEAM_DB` (file), `ATEAM_WORKTREE_ROOT`, `ATEAM_FAKE_SDK: '0'`, `NODE_ENV: 'development'`.

**FACT — DB is a file by default.** `config.ts:45`: `dbPath = env.ATEAM_DB ?? path.join(process.cwd(),'data','ateam.sqlite')`; `openDatabase(config.dbPath)` (`index.ts:29`). Harness points `ATEAM_DB` at an isolated scratch file (`harness.mjs:88`) — this is what lets a driver read `epic_designs` directly for AC5.

**FACT — repoDir/project + worktree root.** The project's working repo is chosen per-project by `POST /api/projects {repoDir}` (`app.ts:165` → `validateRepoDir` → `createProjectWithLead`, `services.ts:45-67`). Git worktrees/clones live under `worktreeRoot = ATEAM_WORKTREE_ROOT ?? os.tmpdir()/ateam-worktrees` (`config.ts:52-54`), always resolved absolute and **outside** the project repo.

---

## 2. Creating a project + team + epic over HTTP

**FACT — Team Lead is AUTO-added; do not add it.** `POST /api/projects` → `createProjectWithLead` calls `store.createAgent({ ...TEAM_LEAD_TEMPLATE })` (`services.ts:56-66`). `TEAM_LEAD_TEMPLATE` (`catalog.ts`) has `kind:'lead'`, `name:'team-lead'` and is **not** in `AGENT_CATALOG`. There is no `team-lead` catalogId; deleting the lead is refused (`app.ts:~360` "Cannot delete the Team Lead").

**FACT — Catalog IDs (`AGENT_CATALOG`, `src/server/agents/catalog.ts`):** `product-manager`, `architect`, `ux-designer`, `frontend-engineer`, `backend-engineer`, `qa-engineer`, `devops-engineer`, `docs-writer`, `researcher`, `code-reviewer`, `security-auditor`, `data-engineer`. For this smoke: **architect** (AC5 designer) and **frontend-engineer** (AC4 builder); `qa-engineer` optional to close the epic.

**FACT — Add specialists:** `POST /api/projects/:id/agents { catalogId }` (`app.ts:~330`). 409 if the same catalogId is already on the team.

**FACT — Two ways to raise an epic, both reach `decomposeEpic`:**
1. `POST /api/projects/:id/chat { content }` (`app.ts:~470`) → `orchestrator.chat()`; a build-intent regex (`/\b(build|implement|create|add|develop|feature|fix|refactor|integrate|migrate|support)\b/i`, `orchestrator.ts:~1010`) triggers `planEpic()` → `decomposeEpic()`.
2. `POST /api/projects/:id/workitems { kind:'epic', title, description }` (`app.ts:~430`) → `orchestrators.get(id).onEpicCreated(epic.id)` → `decomposeEpic()`.

**FACT — Minimal team that triggers design-first decompose.** `decomposeEpic` → `classifyComplexity` (`src/server/complexity.ts:38`). On a **greenfield** repo, non-trivial real work is **always** `'standard'` (`complexity.ts:49` "Greenfield real work always earns a design"), which runs `designThenEnrich` (`orchestrator.ts:~1160`). The designer is `architect ?? this.lead()` (`orchestrator.ts:~1240`) — so even a Lead-only team persists a design; adding `architect` makes AC5's "Architect states the stack" literal, and adding `frontend-engineer` gives AC4 a builder. **Minimal recommended team: `architect` + `frontend-engineer` (+ `qa-engineer` to reach merge).**

---

## 3. Where the design is persisted (AC5)

**FACT — Store API (`src/server/db/store.ts`, "epic design" block):**
```
setEpicDesign({ projectId, epicId, content })  // INSERT INTO epic_designs ... ON CONFLICT(epic_id) DO UPDATE
getEpicDesign(epicId): string                  // SELECT content FROM epic_designs WHERE epic_id=?
deleteEpicDesign(epicId)
```
Table: `epic_designs(epic_id PRIMARY KEY, project_id, content, updated_at)`.

**FACT — Written before builders act.** `orchestrator.designThenEnrich` (`orchestrator.ts:1232-1320`) runs the designer turn, then `this.deps.store.setEpicDesign({ ..., content: text.slice(0,6000) })`, then appends `<!--design-acceptance-->\nDesign acceptance (<stream>): …` to each matching child-task description and emits a `system` event `"<role> designed "<title>" - enriched N task(s) with design acceptance"`. This runs inside `decomposeEpic` for `standard` complexity.

**FACT — Contract builders wait on it.** `runWorkItemInner` calls `awaitEpicDesign(parentId, ATEAM_DESIGN_WAIT_MS ?? 45_000)` for `frontend|backend|data` streams **when an architect is on the team** (`orchestrator.ts:~2080`). `awaitEpicDesign` (`orchestrator.ts:~4490`) polls `getEpicDesign` every 500ms until it lands or the epic is discarded — this is the enforcement that "a design is persisted before the frontend builds."

**FACT — What proves "a stack was stated".** The greenfield design prompt commands the designer to *"DECIDE and state the tech stack, frameworks, language, and project layout"* (`orchestrator.ts:~1250`). Two markers:
1. **`epic_designs.content` non-empty** for the epic (the canonical proof). **No HTTP route exposes it** — a driver reads it from the `ATEAM_DB` file: `SELECT content FROM epic_designs WHERE epic_id = ?`.
2. **`<!--design-acceptance-->`** substring in a child task's `description`, which IS exposed via `GET /api/projects/:id` (`workItems[].description`) — a pure-HTTP proxy signal.

**INFERENCE:** For a robust AC5 assertion: (design content non-empty AND/OR ≥1 task carries `<!--design-acceptance-->`) captured **before** the first frontend `git` "Committed" event (ordering proves "before builders act").

---

## 4. Where builder file output lands (AC4)

**FACT — Isolation is by full local CLONE, not linked worktree** (`src/server/git.ts` header + `createEpicWorktree`). Layout under `worktreeRoot`:
- Epic clone: `worktreeRoot/<projectId>/<epicId>`, branch `ateam/epic-<id>` (`git.ts` `createEpicWorktree`, `worktreePath`).
- Task clone: `worktreeRoot/<projectId>/.tasks-<epicId>/<taskId>`, branch `ateam/task-<id>`, forked off the epic branch tip (`git.ts` `createTaskWorktree`, `taskWorktreePath`).

**FACT — The frontend agent runs in its own task clone.** `runWorkItemInner` (`orchestrator.ts:~1990`): `createTaskWorktree(...)`, sets `cwd = worktree.path`, and the agent writes real files there. Then:
- `commitWork(worktree.path, …)` commits the agent's changes on the **task branch** (`orchestrator.ts:~3350`).
- `integrateTaskBranch(epicClone, epicBranch, taskClone, taskBranch)` merges the task branch into the **epic branch** (`orchestrator.ts:~3380`).
- At epic finish, `mergeEpic(repoDir, epicClonePath, branch)` merges the epic branch into the project repo's base branch (`orchestrator.ts` `approveAndMerge` → `git.mergeEpic`). Nothing is pushed to a remote.

**FACT — "Produced real files" is already enforced server-side.** For gated (non-verifier) build tasks, `produced = git.hasWorkToIntegrate(worktree.path)` (working-tree changes OR commits ahead of base); an empty build retries then escalates (`orchestrator.ts:~2170-2260`). This is exactly the AC4 anti-"loop-on-questions" guard.

**FACT — How a driver detects FE files (several server-authoritative options):**
1. **git (recommended):** `EvalHarness.collectDeliverables()` (`harness.mjs:~330-380`) = new files on the default branch vs a pre-run baseline **plus** `git diff --name-only base..HEAD` on every epic/task clone under `worktreeRoot`, excluding `.ateam`/`.git`. Filter to code files (non-`.md`) → AC4 proof even before merge.
2. **Events:** `GET /api/projects/:id/events` shows the frontend agent's `git` event `"Committed <hash> on ateam/task-…"` with `detail.files` (`orchestrator.ts:~3360`).
3. **Board + report:** the `frontend` task reaching `review`/`done` (`GET /api/projects/:id` workItems) and its posted completion report listing "Files changed (N)" (`postTaskCompletion`, `orchestrator.ts:~3560`).
4. **Post-merge:** `git ls-tree -r --name-only HEAD` in `repoDir` (`harness.gitTrackedFiles`).

**INFERENCE:** Best AC4 assertion = (a `frontend`-stream task exists AND reached `review`/`done`) AND (`collectDeliverables()` contains ≥1 non-`.md` code file attributable to that epic/task clone). Attribution to FE specifically is via the task clone path `.tasks-<epicId>/<frontendTaskId>` or the FE agent's committed-files event.

---

## 5. Epic lifecycle + completion signals

**FACT — `Bus.publish` (`src/server/bus.ts`) fans typed `ServerMessage`s to every WS client.** Events a driver can await (from `orchestrator.ts`):
| Milestone | Signal |
|---|---|
| Epic opened | `workitem.updated` (epic) + `notify('epic', …)` + WS/agent event "Opened epic" |
| Design persisted | agent `system` event "… designed … enriched N task(s)" + child task `workitem.updated` gaining `<!--design-acceptance-->` (+ `epic_designs` row) |
| Task assigned to frontend | `workitem.updated` with `assigneeAgentId` = FE agent + event "Assigned [frontend] …" |
| FE committed / finished | `git` event "Committed <hash> on ateam/task-…" (`detail.files`); task → `review` (`workitem.updated`); `notify('task', …)` |
| PR raised / review | `pull_request.updated` (open → changes_requested/approved/merged); `notify('pr'|'review', …)` |
| Epic delivered/merged | `pull_request.updated` status `merged`; epic `workitem.updated` status `done`; event "Epic … merged and closed"; `notify('merge', …)` |
| Blocked-on-human | `question.updated` (pending); `notify('question', …)` — **a headless driver must answer or it strands** |

**FACT — WS handshake.** On connect the server sends `{ type:'hello', adapter: adapter.name }` (`index.ts:~86`), and `RealCopilotAdapter.name === 'copilot-sdk'` (`realAdapter.ts`), so the driver can assert it really booted the real adapter.

**FACT — The test harness patterns are reusable with the real adapter.** `tests/helpers/testApp.ts` exposes `ctx.store`, `ctx.bus`, `ctx.messages`, and `ctx.waitFor(predicate, timeoutMs)` built purely on `bus.subscribe` — **not** hardcoded to the fake or `NODE_ENV=test`. `createTestApp(homeRoots, adapterOverride)` accepts a real adapter. Limits (FACT): it uses an **in-memory** DB and default `test-model`; it does not spawn a process. **INFERENCE:** fine for an in-process variant, but the file-DB spawn path (`evals/`) is the durable, product-faithful choice and already has WS capture + git-based deliverable scoring.

---

## 6. Cost / time / flake realities (must be bounded)

**FACT — Per-turn safety timeout is 15 min.** `realAdapter.ts` `runTurn`: `const safety = setTimeout(() => finish(), 15 * 60_000)`. A wedged model turn resolves empty after 15 min rather than hanging forever.

**FACT — Bounded design + gate knobs (env):**
- `ATEAM_DESIGN_TIMEOUT_MS` (design turn) default 45_000 (`orchestrator.ts` `designThenEnrich`).
- `ATEAM_DESIGN_WAIT_MS` (builder waits for design) default 45_000 (`awaitEpicDesign`).
- `ATEAM_QA_TEST_TIMEOUT_MS` (build/test/probe) default 240_000.
- `ATEAM_DEP_INSTALL_TIMEOUT_MS` default 300_000 (`ensureGateDeps`).
- `ATEAM_LEAD_TICK_MS` 15_000, `ATEAM_STALL_MS` 120_000, `ATEAM_RUN_WATCHDOG_MS` 300_000, `ATEAM_EPIC_CONCURRENCY` 3, `ATEAM_MAX_REVIEW_ITER` 3, review-fix budget 12, remediation rounds 3.
- Scenario cap: `evals/run.mjs` `smoke.defaultTimeoutMin = 15`; harness `monitorUntil` also aborts after `MAX_FAILS=6` unreachable snapshots (≈30s) → treats server as crashed.

**HYPOTHESIS/RISK — what makes a live smoke hang or strand:**
1. **Parked question with no answerer.** Review/acceptance/no-code escalations call `raiseQuestion` and wait on an in-memory promise (`orchestrator.ts:~5230`). A headless run that never `POST /api/questions/:id/answer` (`app.ts:~560`) will sit until the scenario timeout. Mitigation: the `until` predicate + hard `timeoutMs`; optionally auto-answer.
2. **Copilot not authenticated.** `warmModels` logs "not authenticated" and `listModels()` returns `[]`; turns fail with `⚠ … run failed`. Harness `detectAuthIssue()` reads the server log for this. A live run must pre-verify `copilot` auth (parent already confirmed `CopilotClient().start()` + `listModels()→[{id:"auto"}]` in this env — **FACT as given**).
3. **Nondeterminism (the point of AC4/AC5).** The real model may still ask a clarifying question or emit no code; retries/restart/lead-assist recover, but the run must be bounded and idempotent. AC4 explicitly proves it *doesn't* loop.
4. **Cost/time.** Multiple turns per task × 15-min ceilings; a full epic is minutes, not seconds. Keep the epic tiny (single frontend slice) and the team small (architect + frontend + qa).
5. **Windows cleanup.** Git child processes briefly lock clone dirs; harness `stop()` uses `taskkill /T /F` and `rmDir` retries EPERM — reuse, don't hand-roll.

---

## 7. Conventions

**FACT (absence-proofs — reads returned ENOENT):**
- `C:/code/projects/cohort/AGENTS.md` → **not present**.
- `C:/code/projects/cohort/.github/copilot-instructions.md` → **not present**.
- `C:/code/projects/cohort/CONTRIBUTING.md` → **not present**.
(CLAUDE.md not found at root either; no root conventions doc governs script/test placement.)

**FACT — Commands (`package.json` scripts):** `build` = `vite build`; `typecheck` = `tsc -p tsconfig.json --noEmit`; `lint` = `eslint . --max-warnings 0`; `test` = `vitest run`; `test:coverage` = `vitest run --coverage`; `e2e` = `playwright test`; `eval` = `node evals/run.mjs`; `dev:server` = `tsx watch src/server/index.ts`; `start` = `cross-env NODE_ENV=production tsx src/server/index.ts`.

**FACT — Where one-off / live-networked runs live:** `evals/` (`evals/run.mjs` CLI, `evals/harness.mjs` engine, `evals/reports/` outputs). There is also a `scripts/` dir (referenced `scripts/dev-web.mjs`). The live smoke is **opt-in by omitting `--fake`** (real SDK), already isolated (own port/DB/worktree/scratch, nothing touches the app's own repo). A `smoke` scenario already exists (`team: ['frontend-engineer','qa-engineer']`, greenfield). **INFERENCE:** the bulletproof run should add/extend a scenario here (adding `architect` and AC4/AC5 acceptance checks) rather than introduce a parallel script.

---

## How a driver detects AC4 (files) and AC5 (design) after a run

**AC5 — design persisted before builders act:**
- Primary (DB, exact): open `ATEAM_DB` (better-sqlite3) → `SELECT content FROM epic_designs WHERE epic_id = ?`; assert non-empty (and, for the "stack stated" bar, that it names a language/framework/layout — the greenfield prompt forces this).
- Proxy (HTTP-only): `GET /api/projects/:id` → any `workItems[].description` contains `<!--design-acceptance-->`.
- Ordering: capture this **before** the first frontend `git` "Committed" WS/event (proves design-first). `awaitEpicDesign` structurally enforces the ordering when an architect is on the team.

**AC4 — frontend decided under uncertainty and produced real code files:**
- `EvalHarness.collectDeliverables()` returns ≥1 **non-`.md` code file** on the frontend task/epic clone or merged default branch; AND a `frontend`-stream task reached `review`/`done`; AND (attribution) the FE agent emitted a `git` "Committed … on ateam/task-…" event with `detail.files`.
- Negative guard for "didn't loop on questions": assert **no pending `question.updated`** authored by the frontend agent blocked the task (i.e. FE task did not terminate in `needs_input`).

## Blast radius / risks
- **Read-only to app code:** the run only calls HTTP + reads the DB file/worktrees; it must not merge into `cohort` itself — `worktreeRoot` and the target repo are isolated under scratch (`config.ts:52`, `harness.makeGreenfieldRepo`).
- **Nondeterminism & cost:** real LLM; bound every turn (15-min ceiling), the scenario (`timeoutMin`), and stall/watchdog knobs; keep epic + team minimal.
- **Strand-on-question:** headless runs must either finish before any escalation or answer questions via the API; otherwise they idle to timeout.
- **Auth precondition:** requires an authenticated `copilot`; assert `hello.adapter === 'copilot-sdk'` and `detectAuthIssue()==false` up front.
- **Flake surfaces:** Windows clone locks (use harness cleanup), first-run dependency installs (`ensureGateDeps`, 300s), and empty-turn retries can extend wall-clock — budget generously and treat a single retry as normal, not failure.
