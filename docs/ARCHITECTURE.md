# Cohort — Architecture

How Cohort is built: the runtime shape, the major components, the data model, and
the lifecycle of a request from chat message to merged branch.

See also: [USER-GUIDE](./USER-GUIDE.md) · [CONFIGURATION](./CONFIGURATION.md) ·
[AGENTS](./AGENTS.md).

---

## 1. Runtime shape

Cohort is a **single-user local web app**. A React SPA talks to a Fastify server
over REST + a WebSocket; the server orchestrates GitHub Copilot SDK agents against
your local repositories and persists everything to SQLite.

```
Browser (React 19 / Vite)
  │   REST (fetch)                WebSocket (/ws)
  ▼                                     ▲
Fastify server (src/server)             │  ServerMessage stream (events, status,
  ├─ HTTP API  ......... app.ts         │  chat deltas, board/PR/question updates)
  ├─ Event bus ......... bus.ts ────────┘
  ├─ SQLite store ...... db/store.ts, db/database.ts   (better-sqlite3)
  ├─ Orchestrator ...... orchestrator.ts   (ONE per project, run in parallel)
  │    • per-agent AgentSession actors + mailboxes
  │    • epic planning → stream-tagged tasks → assign → PR → review → merge
  │    • DAG scheduling, constraints, verification/QA gates
  ├─ GitService ........ git.ts        (per-epic branch + isolated worktree)
  ├─ Scheduler ......... scheduler.ts  (wait/poll + scheduled/recurring items)
  ├─ SessionRecorder ... sessionRecorder.ts   (optional turn transcripts)
  └─ CopilotAdapter (agents/)
       • RealCopilotAdapter → @github/copilot-sdk   (agents/realAdapter.ts)
       • FakeCopilotAdapter → deterministic, offline (agents/fakeAdapter.ts)
```

The LLM lives entirely behind the **`CopilotAdapter` seam** (`agents/adapter.ts`),
so the app and its tests never depend on a live model. `ATEAM_FAKE_SDK=1` swaps in
the fake adapter.

---

## 2. Source layout

```
src/
  shared/        Types + contracts shared by server and web (the single source of truth)
    domain.ts      Core domain model (Project, Agent, WorkItem, PullRequest, …)
    api.ts         REST request/response contracts (Zod)
    ws.ts          WebSocket ServerMessage discriminated union
    index.ts       Barrel re-export (imported as @shared/*)

  server/
    index.ts       Process entry: build app, listen, wire WebSocket
    app.ts         Fastify routes (REST API surface)
    bus.ts         In-process event bus → fans out to WebSocket clients
    config.ts      Env-derived configuration (ports, paths, caps, timeouts)
    orchestrator.ts  The brain: one instance per project (see §5)
    dag.ts         Task dependency graph + ready-set scheduling
    constraints.ts   Hard constraints the reviewer/gates must honor
    verification.ts  Deterministic verification gate (task/epic scope)
    qaGate.ts        Build/test/acceptance gate execution
    streamScope.ts   Maps review comments → streams → fix tasks
    git.ts         GitService: branches, isolated worktrees, diffs, --no-ff merges
    scheduler.ts   wait/poll + scheduled/recurring work items
    sessionRecorder.ts  Optional per-turn transcript recording
    services.ts    Shared service wiring
    agents/
      adapter.ts     CopilotAdapter interface (the seam)
      realAdapter.ts @github/copilot-sdk implementation
      fakeAdapter.ts deterministic offline implementation (tests, UI dev)
      catalog.ts     12 specialist templates + Team Lead prompt
      context.ts     Builds each agent's grounding context (project/env/team)
      skillScanner.ts Discovers SKILL.md skills from home + project roots
    db/
      database.ts    SQLite connection + schema/migrations
      store.ts       Typed data-access layer over every table

  web/
    main.tsx, App.tsx  SPA shell + routing
    api.ts, state.tsx  REST client + global state/WebSocket subscription
    theme.ts           Palette (default|comic) × mode (dark|light)
    pages/             Projects, Dashboard, Chat, Board, Agents, AgentDetail,
                       Activity, Recordings, Notifications, Git, Settings
    components/        Markdown renderer + shared UI primitives
```

---

## 3. Data model (SQLite)

All persisted types live in `src/shared/domain.ts`. The principal entities:

- **Project** — name, absolute `repoDir`, and `ProjectSettings` (default model,
  approval mode, extra skill roots, paused, recordSessions, and optional
  `testCommand` / `buildCommand` / `acceptanceCommand`).
- **Agent** — the Team Lead (`kind: 'lead'`) or a specialist; persona `prompt`, tool
  allow-list, `skills`, `model`, and live `status`.
- **WorkItem** — an **epic** (a user request) or a **task** (a stream-tagged unit
  with `dependsOn`, `assigneeAgentId`, `branch`, `scheduledAt`, `recurrence`,
  `progress`). Board status is one of `backlog | todo | in_progress | review | done`.
- **AgentTask / AgentNote** — an agent's personal task list and append-only
  scratchpad.
- **Thread / ChatMessage** — the `main` user↔team channel and Lead-moderated
  `group`/`dm` threads.
- **PullRequest / PrComment** — the review artifact (branch, base, diff, commits,
  files) and routed review comments, each with a fix task.
- **AcceptanceCriterion** — PM-authored Given/When/Then criteria persisted per epic
  so later gates can map each to a test.
- **VerificationReportRecord / VerificationCheck** — append-only, auditable gate
  decisions (required vs advisory checks).
- **EpicMetrics** — per-epic delivery/parallelism telemetry captured at merge.
- **Question** — an escalation surfaced to the user.
- **Notification** — user-facing notifications for the panel.
- **UsageEntry** — accumulated time + token usage, keyed by work item and agent.
- **RecordedTurn** — optional full transcript of one agent turn (on disk, one JSON
  object per line, when recording is enabled).

---

## 4. Communication: REST + WebSocket

- **REST** (`src/server/app.ts`) — CRUD and actions: projects, agents, catalog,
  work items, chat, threads, pulls, PR comments, criteria, verification, metrics,
  git snapshot, skills, questions, notifications, recordings, models, and an fs
  directory picker. Contracts are Zod-validated in `src/shared/api.ts`.
- **WebSocket** (`/ws`) — the server pushes a `ServerMessage` discriminated union
  (`src/shared/ws.ts`) for every live change: `event.appended`, `agent.status`,
  `workitem.updated`, `chat.message` / `chat.delta`, `pull_request.updated`,
  `question.updated`, `criteria.updated`, `usage.updated`, and more. The client
  filters by `projectId` and updates state in place — no polling.

The in-process **event bus** (`bus.ts`) is the single fan-out point: the
orchestrator and store publish to it; the WebSocket layer subscribes and relays.

---

## 5. The orchestrator: request → merge

One **Orchestrator** instance runs per project (so multiple projects/teams execute
in parallel). Within a project it manages one **AgentSession actor per agent**, each
with a mailbox — an independent, grounded SDK session bound to that agent's worktree.

Lifecycle of a user request:

1. **Intake & clarify.** A chat message to the Team Lead becomes a candidate epic.
   The Lead consults the PM, asks the user only plan-changing questions (batched,
   each with a recommended default), and persists **acceptance criteria**.
2. **Design & decompose.** Optionally a short group brainstorm, then the Architect
   produces a design and the Lead decomposes the epic into **stream-tagged tasks**
   with dependencies. The system materializes these as board cards (`dag.ts` tracks
   the dependency graph).
3. **Isolate.** `GitService` creates the epic branch `ateam/epic-<id>` in an
   **isolated worktree** rooted at an absolute temp location — never inside a project
   or the app repo. `main`/`master` is never touched.
4. **Parallel execution.** Ready tasks (no unmet deps) are assigned across streams up
   to `ATEAM_EPIC_CONCURRENCY` (default 3). Independent streams build in parallel in
   their own task clones; integration back into the epic branch is **serialized** to
   avoid conflicts. Contract-consuming builders wait up to `ATEAM_DESIGN_WAIT_MS` for
   the Architect's shared-interface design before proceeding.
5. **Verify.** Each task passes a **verification gate** (`verification.ts`) and the
   epic passes **build/test/acceptance gates** (`qaGate.ts`). Gate decisions are
   recorded as append-only, auditable reports. Objective gates run even when review
   comments are waived.
6. **Review loop.** The Lead opens a **PR**; an independent reviewer files
   severity-ranked comments routed to streams (`streamScope.ts`). The Lead assigns
   fix tasks and iterates. After `ATEAM_MAX_REVIEW_ITER` rounds with open comments,
   the epic **parks and asks the user**.
7. **Merge.** On approval + passing gates, the branch merges with `git merge --no-ff`
   onto its base. `EpicMetrics` are captured, and the worktree is reclaimed.

Cross-cutting services: the **Scheduler** handles `wait`/`poll` and
scheduled/recurring items; the **SessionRecorder** optionally writes full turn
transcripts; **constraints** (`constraints.ts`) encode hard rules the reviewer and
gates must not violate (e.g. never demand a constraint-breaking fix).

---

## 6. Agents are real, grounded actors

Each specialist is its own SDK session (`agents/context.ts` builds its grounding:
the project, the environment, and its teammates). Agents genuinely communicate —
group **brainstorm threads**, escalation, and multi-author chat — rather than being
prompt fragments of one model. The **Team Lead** is the sole orchestrator and the
only agent the user talks to.

---

## 7. Safety model

- **Workspace-scoped permissions.** In `auto-workspace` mode agents auto-run tools
  inside the repo dir; writes outside are blocked. `manual` mode requires user
  approval per action.
- **Worktree isolation.** Every epic runs on its own branch in an isolated worktree
  at an absolute temp path, so parallel epics never collide and the primary checkout
  stays clean.
- **No implicit merges.** `main`/`master` is only ever updated by an explicit,
  reviewed, gate-passing `--no-ff` merge.
- **Deterministic testability.** The `CopilotAdapter` seam + fake adapter make the
  entire system runnable offline and in CI without a live model.

---

## 8. Configuration & limits

All tunables are environment variables (prefix `ATEAM_`) resolved in
`src/server/config.ts` — ports, DB path, default model, skill roots, worktree root,
epic concurrency, review-round budget, design-wait, and dependency-install timeout.
See [CONFIGURATION](./CONFIGURATION.md) for the full list.

---

## 9. Known boundaries

- Git is **local only** today: branches, worktrees, and `--no-ff` merges — no remote
  push or hosted PRs yet.
- Single local user; no multi-user auth.
- No desktop packaging (runs as a local web app).
