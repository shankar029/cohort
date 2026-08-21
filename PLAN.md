# ateam — Agents Team — Delivery Plan

**Goal:** A local web app where a user creates projects (each pointed at a locally
checked-out repo), builds a per-project team of GitHub-Copilot-SDK agents, talks only to a
**Team Lead** agent that orchestrates specialist sub-agents, manages work on a Kanban board
(assign → agent auto-picks-up → works → pulls next), and watches each agent's live status,
tasks, and logs. Multiple projects/teams run in parallel.

**Status:** v1 done; **v2 (async multi-agent) in progress** — see "v2" section at the bottom.

---

## Project profile

- **Greenfield**, empty dir, fresh `git init`. Runtime: **Node v24**, npm 11. No .NET/Python.
- **Stack (decided):** TypeScript everywhere. **React + Vite + Tailwind** (web), **Fastify +
  `ws`** (server, live event streaming), **better-sqlite3** (local persistence),
  **`@github/copilot-sdk`** (agent runtime, via local Copilot CLI `1.0.79`, logged-in user auth).
  Tests: **Vitest** (unit/integration) + **Playwright** (E2E). Monorepo via **npm workspaces**:
  `packages/shared`, `packages/server`, `packages/web`. Root scripts orchestrate dev/test/build.
- **Conventions:** Conventional Commits, `feat/ateam` branch, ESLint + Prettier + `tsc` strict.

## Confirmed decisions (from user)

1. Local web app (no desktop wrapper). 2. **Model selectable per agent** (default
   `claude-sonnet-4.5`, overridable). 3. **Projects point at a local repo dir**; app operates in
   that dir. 4. **Multiple projects, teams per project, run in parallel.** 5. **Autonomous pull
   loop**: idle agent pulls next board item. 6. **Escalation**: specialist → Team Lead →
   (decides | asks user). 7. Real agent execution; auto-approve reads always, writes/shell
   auto-approved **only within the project's workspace dir**, with a per-project manual-approval
   toggle. 8. MVP-complete app-scale bar (every named surface working end-to-end + tests), not
   cloud/prod ops.

## Acceptance criteria (union = full request)

- **AC1** App runs locally: `npm install && npm run dev` starts server+web; documented.
- **AC2** Agents driven by `@github/copilot-sdk` over the local Copilot CLI; per-agent model.
- **AC3** Projects: create a project pointing to a local repo dir; list/switch; delete.
- **AC4** Multiple projects & their teams run **in parallel** (independent sessions/state).
- **AC5** Team builder: create a team; add agents from a **catalog**; create a **custom** agent
  (name, description, prompt, tools, skills, model).
- **AC6** Catalog ships with ≥6 highly-specialized agents (UX/UI, Frontend, Backend, QA/Test,
  DevOps, Docs, Researcher, Reviewer, …).
- **AC7** Team Lead: the single conversational agent the user talks to; it **delegates**
  internally to specialist sub-agents (SDK native). User never talks to specialists directly.
- **AC8** Kanban board: create work items; columns (Backlog/Todo/In Progress/Review/Done);
  **assign an item to a specific agent**.
- **AC9** Assigned agent **auto-picks-up** the item and works it; card advances across columns;
  on completion the agent **pulls the next** available item.
- **AC10** Per-agent **task board**: each agent maintains its own tasks, visible to the user.
- **AC11** Per-agent **status + activity log** page: live stream of messages, reasoning, tool
  calls, and sub-agent lifecycle; persisted and replayable.
- **AC12** Live visibility: user sees what every agent is doing though only interacting with the
  Team Lead.
- **AC13** **Skill discovery**: load all skills from system home roots (`~/.agents/skills`,
  `~/.pi/**/skills`) and the project (`<repo>/.agents/skills`, `<repo>/skills`); selectable per
  agent; injected via SDK `skillDirectories` + agent `skills[]`.
- **AC14** **Escalation**: a specialist's question routes to the Team Lead, which either answers
  or **asks the user** (surfaced in UI, answer flows back).
- **AC15** Local persistence (SQLite): projects, teams, agents, work items, tasks, messages,
  logs survive restart.
- **AC16** Quality: unit + integration + Playwright E2E green; lint/type/build clean; evidence.
- **NFRs:** WCAG 2.2 AA UI, responsive, loading/empty/error/success states; workspace-scoped
  permission gating; no secrets persisted; graceful SDK/CLI-unavailable degradation.

## Architecture

```
packages/
  shared/   Zod schemas + TS types shared by server & web (WS message contracts, DTOs)
  server/   Fastify HTTP + ws; SQLite (better-sqlite3) repos; services:
            - CopilotAdapter (interface) → RealCopilotAdapter (@github/copilot-sdk)
                                         → FakeCopilotAdapter (deterministic, for tests/offline)
            - ProjectService, TeamService, AgentCatalog, SkillScanner
            - Orchestrator (per project): Team-Lead session, sub-agent delegation,
              autonomous pull loop, escalation via onUserInputRequest
            - EventStore (persist session events → per-agent logs) + WS broadcaster
  web/      React + Vite + Tailwind; pages: Projects, Chat, Board, Agents(+detail task board),
            Activity(status+logs), Settings; WS client for live streams
tests/e2e/  Playwright specs (run against server with FakeCopilotAdapter)
```

- **SDK usage:** one `CopilotClient`; per project a Team-Lead **session** with
  `workingDirectory = repoDir`, `customAgents = team specialists` (scoped `tools`, `prompt`,
  `skills`, per-agent `model`), `defaultAgent.excludedTools` to force orchestration, and
  `onUserInputRequest`/`onPermissionRequest` handlers. Specialist work = SDK sub-agent
  delegation; per-agent logs come from event envelope `agentId`/sub-agent `toolCallId`.
- **Testability:** the LLM is an external dependency → `CopilotAdapter` seam. `FakeCopilotAdapter`
  emits realistic scripted event streams so unit/integration/E2E are deterministic and offline.
  `RealCopilotAdapter` is exercised by an opt-in integration test (`ATEAM_LIVE=1`) + manual E2E.

## Milestones (app-scale: walking skeleton → thicken). One commit each on `feat/ateam`.

- [x] **M0 Walking skeleton** — workspaces + tooling (TS/ESLint/Prettier/Vitest/Playwright/
      Tailwind); shared contracts; SQLite schema+migrations; Fastify+ws; CopilotAdapter seam +
      Fake; create/list projects; Team-Lead chat send → streamed reply over WS; app shell + nav;
      one unit + one integration + one E2E green.
- [x] **M1 Agents, catalog & team builder** — catalog data (≥8 specialists); team CRUD; add from
      catalog; create custom agent (name/desc/prompt/tools/skills/**model**); Agents page + detail.
- [x] **M2 Kanban board** — work items CRUD; columns; move; **assign to agent**; board UI + DnD.
- [x] **M3 Orchestration & autonomous pickup** — assign → Orchestrator dispatches to Team Lead →
      delegates to assignee sub-agent; card advances; on idle **pull next** item; per-agent task
      board reflects items+subtasks. Parallel across projects.
- [x] **M4 Live status & logs** — persist events → per-agent Activity page (status + timeline of
      messages/reasoning/tool calls/subagent events); live via WS.
- [x] **M5 Skill discovery** — SkillScanner over home + project roots; skill catalog; wire into
      agent `skills[]` + session `skillDirectories`.
- [x] **M6 Escalation** — `onUserInputRequest` → Team-Lead consult → UI "needs input" flow →
      answer routed back; permission-approval prompts when manual mode on.
- [x] **M7 Settings, parallelism proof, hardening** — global/project settings (default model,
      approval mode, home skill roots); multi-project parallel E2E + cross-feature smoke;
      README/runbook; `.env.example`; production-readiness notes.

## Test strategy

- **Unit (Vitest):** SkillScanner parsing, AgentCatalog, permission-policy (workspace scoping),
  Orchestrator state machine (assign→in-progress→review→done→pull-next), EventStore mapping,
  shared Zod contracts.
- **Integration (Vitest):** server routes + SQLite repos (projects/teams/agents/items),
  WS event broadcast, Orchestrator↔FakeCopilotAdapter end-to-end (delegation, escalation).
- **E2E (Playwright, FakeCopilotAdapter):** create project → build team from catalog → chat Team
  Lead → create+assign work item → watch auto-pickup move card → view agent task board + live log
  → escalation question answered. Cross-feature smoke across two parallel projects.
- **Live (opt-in):** `ATEAM_LIVE=1` integration test hits the real Copilot CLI for one turn.
- Coverage: meaningful coverage of all new branches (greenfield → establish the bar).

## Production readiness (right-sized; local app)

- Build/run: `npm run dev` / `npm run build` + serve — **in scope**. Config via `.env`
  (COPILOT model default, ports, home skill roots) + `.env.example` — **in scope**. Secrets: rely
  on Copilot CLI login; none persisted — **in scope**. Cloud deploy/CI/CD/TLS/scaling/DR —
  **N/A (local-only app)**; documented as follow-ups. Data: SQLite file + lightweight migrations
  — **in scope**. Observability: structured server logs + optional SDK telemetry hook — **in
  scope (basic)**.

## UX design (design-first — approve before UI build)

- **IA / nav:** left rail = **Projects switcher** (with "＋ New Project") + active-project nav:
  **Chat · Board · Agents · Activity · Settings**. Top bar: project name, repo path, global
  status (agents working / idle / needs-input badge).
- **Design system:** Tailwind tokens — 4px spacing scale; type scale (12/14/16/20/28); dark-first
  palette with semantic status colors **idle** (slate) / **working** (blue, animated) /
  **needs-input** (amber) / **blocked** (red) / **done** (green); reusable components: Button,
  IconButton, Card, Badge/StatusPill, Modal, Toast, Avatar, Column, EmptyState, Skeleton,
  LogLine. Focus-visible rings, ≥44px targets, ARIA roles (board = labelled lists), contrast ≥4.5.
- **Screens & all states:**
  - **Projects:** grid of project cards (name, repo path, agent count, live status) + create
    modal (name + repo dir picker/validated path). States: loading skeletons / empty ("Create
    your first project") / error (invalid path) / success.
  - **Chat (Team Lead):** message thread (user ↔ Team Lead), streaming assistant text +
    collapsible "delegated to <Specialist>" trace chips; composer; "needs input" inline prompt
    when Team Lead asks the user. States: idle/streaming/awaiting-input/error.
  - **Board:** 5 columns, work-item cards (title, assignee avatar, status pill, priority);
    create-item modal; assign dropdown; drag between columns. States: empty column / dragging /
    working card (animated) / error.
  - **Agents:** roster cards (avatar, role, model, status) → detail = agent's **task board**
    (its items/subtasks) + config. Add-from-catalog drawer + create-custom form.
  - **Activity:** per-agent status header + reverse-chron **log timeline** (message / reasoning /
    tool-call / subagent lifecycle, color-coded, filterable). Live-tailing + replay.
  - **Settings:** default model, approval mode (auto-in-workspace | manual), home skill roots,
    theme. States: saved toast / validation error.
- **Approval:** app-scale gate — approve **nav shell + design system + M0 flow** once here.

## Risks & rollback

- **EMU/Entra identity** (`shbs_microsoft`) may block `gh` PR creation on personal repos; no
  remote configured → **fallback:** clean local commit(s) on `feat/ateam` + exact push/PR
  commands. (Ship-gate compliant.)
- **SDK is preview** (`1.0.11-preview.2`) → isolated behind `CopilotAdapter`; app + tests never
  depend on live LLM. Real path verified via opt-in live test.
- **Native module** (better-sqlite3) build on Windows/Node 24 → verify early in M0; fallback
  `node:sqlite` if needed.
- **Long-running agent turns** → async orchestration, WS streaming, abort support.

## Decisions log

- 2026-08-20 — Chose SDK-native sub-agent delegation (customAgents on one Team-Lead session per
  project) over a bespoke multi-session mesh: honors the platform, gives per-agent event streams
  free, less tech debt.
- 2026-08-20 — `CopilotAdapter` seam with a Fake impl: deterministic offline tests + resilience to
  preview-SDK churn. Not a behavior-hiding mock — the real adapter ships and is live-tested.
- 2026-08-20 — npm workspaces (shared/server/web) to share typed contracts without a bundler clash.

## Iterations log (convergence)

- **Iter 1** — Built M0–M7 against the Fake adapter. Bug: workspace-scoped permission resolved
  relative paths against cwd, rejecting legit in-repo writes and blocking the escalation path.
  Root cause: path not resolved against the repo root. Fixed `isInsideWorkspace`; integration green.
- **Iter 2** — Live SDK test surfaced `claude-sonnet-4.5` not available on this account. Root cause:
  hardcoded default model isn't guaranteed per-account. Fixed: default → `auto`, added live
  `/api/models` discovery + per-agent `ModelSelect`. Re-verified: live test passes; all suites green.

- **Iter 3** — Real-adapter app “failed after a few requests” (hard crash + WS proxy ECONNABORTED).
  Root causes, all fixed: (1) `RealTeamSession` serialized queue was **poisoned** by any rejected
  turn — every later `send` silently skipped `runTurn`; rewrote so both chain branches run the next
  turn. (2) A turn could **hang forever** waiting on `session.idle`; added an absolute safety timeout
  and made turns never reject. (3) **No global process guards** — one escaped rejection/throw crashed
  Node; added `unhandledRejection`/`uncaughtException` handlers + WS send try/catch + guarded event
  handler. (4) SDK probe revealed `session.send()` returns an **id ack immediately** (not turn
  completion) and streamed-only replies emit no discrete `assistant.message`; resolve strictly on
  `session.idle` and finalize the stored message from the delta buffer. (5) Hardened the Vite
  `/api` + `/ws` proxy with error handlers. Verified: live test + a real 2-turn smoke (server stays
  up, both turns answer) + full unit/integration/E2E suite green.

## Final scorecard (top-1% rubric, target ≥4/5)

| #   | Dimension               | Score | Justification                                                                             |
| --- | ----------------------- | ----- | ----------------------------------------------------------------------------------------- |
| 1   | Correctness             | 5     | 14 unit/integration + 3 Playwright E2E + 1 live SDK test green; every AC demonstrated.    |
| 2   | Scope fidelity          | 5     | Every requested surface delivered; no gold-plating; extras listed as follow-ups.          |
| 3   | Reuse & DRY             | 4     | Shared Zod/type contracts; single Store; adapter seam; no duplicated logic.               |
| 4   | Design & principles     | 5     | Clean layering (shared/server/web), adapter pattern, one orchestrator per project.        |
| 5   | Extensibility           | 5     | New agents via catalog data; new events/WS msgs additive; runtime is adapter-swappable.   |
| 6   | Robustness              | 4     | Zod validation, workspace-scoped permissions, WS reconnect, graceful fake fallback.       |
| 7   | Test quality            | 4     | Real unit + integration + browser E2E + opt-in live; covers delegation/pickup/escalation. |
| 8   | Verification & evidence | 5     | Live SDK proof + Playwright + full suite; evidence captured in the PR/commit.             |

---

# v2 — Truly-async multi-agent redesign

**Goal:** Agents are independent, concurrent actors that really talk, brainstorm, and
collaborate. The Team Lead plans epics, runs group discussions, decomposes work onto the
Kanban board, and coordinates a real git + PR/review workflow. The user talks to the Lead,
but the whole team's conversation is visible.

## Locked decisions

- **One SDK session per agent** (independent actors + mailboxes), not SDK sub-agents.
- **Truly async**: agents run concurrently (parallel `ask()` calls); Lead coordinates.
- **Threads**: `main` (user↔team) + `group` (brainstorm/discussion, Lead-moderated) + `dm`.
  The Lead can open a group chat; any agent can **request** one and the Lead opens it.
- **Every user request is an Epic** → clarify → (brainstorm) → decompose into stream-tagged
  tasks on the board → assign → agents work async → PR → review → merge to feature branch.
- **Real git**: ateam `git init`s the project repo if needed, works on branches, commits;
  in-app PR objects; real `gh` only when a remote + auth exist.
- **Product Manager** agent added; all agent personas rewritten to principal/staff level.

## Architecture

- `AgentSession` seam (per agent): `ask(prompt) → finalText` + streamed events
  (message/delta/reasoning/tool/idle). Fake + Real implementations.
- `ProjectOrchestrator` = actor system: one `AgentActor` per agent (session + serialized
  mailbox). Routes messages between actors, main thread, and group threads.
- `GitService`: init/branch/commit/merge/diff in the project repo.

## Milestones

- [~] **M8 Engine rewrite** \u2014 per-agent `AgentSession` (fake+real); actor orchestrator;
  multi-author threads; **group brainstorm** (Lead-led + agent-requested); correct status.
- [ ] **M9 Epic planning** \u2014 user request → epic; clarify (batched) + PM consult; decompose
      into stream-tagged task cards with acceptance criteria + deps; assign; schedule parallel.
- [ ] **M10 Async task execution** \u2014 agents pick up ready tasks concurrently; post updates to
      main thread as themselves; move cards; git branch+commit per task.
- [ ] **M11 PR + review** \u2014 raise in-app PR (diff); reviewer/security agent reviews →
      approve/changes → merge to feature branch; Lead plans the gate.
- [ ] **M12 UI** \u2014 multi-author chat, Threads/group-chat panel, grouped-by-task Activity,
      Epic→Task board hierarchy, PR view.
- [ ] **M13 Polish** — PM agent + top-tier personas; live-adapter proof; hardening.

## Cross-cutting: agent grounding

- Every agent's system prompt is composed from: persona + **environment** (it is an
  autonomous agent in ateam with its own workspace session) + **project** (name, repo path,
  detected stack) + **teammates** (roster with names/roles) + **collaboration protocol**
  (how to talk in threads, request a group chat, escalate via the Lead). Built by `context.ts`.

## Iterations log (v2)

- (populated as milestones land)

## Added requirements (fold into M9–M11)

- **Agents are first-class app users**: the Lead _and_ specialists can create and move work items,
  post to threads, and call/join discussions via agent-callable tools (`create_work_item`,
  `move_work_item`, `post_message`, `request_group_chat`, `raise_pr`, `review_pr`) that map to the
  same store/bus the UI uses — so agent actions show up live in the board/chat.
- **Iterate to quality**: work items loop (in_progress → review → changes_requested → in_progress)
  until the reviewer/QA quality bar passes; the Lead may convene **multiple** group discussions as
  needed, exactly like a human team, before marking an epic done.
- **Agent scratchpads / planning surface**: each agent gets a private notes space (free-form
  markdown "notepad/whiteboard") plus its existing task board. When an agent picks up a work item
  it can jot plans, decisions, and thoughts (persisted, visible on its detail page) and maintain a
  checklist — the tools an engineer uses to plan and execute. New: `agent_notes` store + tools
  `write_note` / `update_plan`, surfaced on the Agent detail page.
- **Scheduling for agents**: a `SchedulerService` (timers + `sleep` + `waitUntil` polling +
  per-owner cleanup) exposed to agents as tools `wait` (pause/retry after a delay) and `poll`
  (re-run a shell check every N seconds until it succeeds or times out) — so an agent can wait for
  an event/command to complete, poll for a condition, or wait-and-retry. Cleaned up on shutdown.
- **User-scheduled work items**: a work item can carry a `scheduledAt` (specific time) and
  `recurrence` (none/hourly/daily/weekly) and be assigned to an agent. Scheduled items wait in
  backlog; the SchedulerService activates them at their time (→ todo → autonomous pickup) and, when
  recurring, spawns the next future occurrence. Re-armed on server boot. Board form exposes a
  datetime + repeat picker; cards show an ⏰ badge.
- **Team Lead owns the project end-to-end**: the Lead's grounding makes it accountable for
  delivering every request as a working, maintained, high-quality feature — clarify → epic →
  decompose by stream → assign in parallel → git/PR/review → drive iteration until the quality bar
  is met. Full workflow lands with M9–M11; grounding elevated now.

## Execution phases (backlog grouped; tackled one by one)

Done already: M8 engine, agent scheduling primitives (wait/poll), user-scheduled/recurring
work items, Lead ownership grounding, startup-migration fix.

- [x] **Phase 1 — Agents as first-class app users (tool layer).** Agent-callable tools mapped to
      the same store/bus the UI uses: `create_work_item`, `move_work_item`, `post_message`,
      `request_group_chat`, `list_board`. Real adapter registers SDK tools; Fake adapter drives them
      via markers. Foundation for Phases 2–4.
- [x] **Phase 2 — Epic planning & decomposition (M9).** Every user request → an Epic. Lead
      clarifies (batched) + consults the PM, then decomposes into stream-tagged task cards with
      acceptance criteria + dependencies, and assigns for parallelism.
- [ ] **Phase 3 — Async task execution + GitService (M10).** `GitService` (init/branch/commit/
      merge/diff). Agents pick up ready tasks concurrently (respecting deps), post updates as
      themselves, move cards, commit on a per-task branch.
- [ ] **Phase 4 — PR + review + iterate-to-quality (M11).** In-app PR objects (diff); reviewer/QA
      agent reviews → approve/changes_requested → merge to the epic branch; loop
      in_progress→review→changes_requested until the quality bar passes.
- [ ] **Phase 5 — Agent scratchpads / planning surface.** `agent_notes` store + `write_note` /
      `update_plan` tools; free-form notepad + checklist surfaced on the Agent detail page.
- [ ] **Phase 6 — UX modernization + UI features (M12 + UX).** Redesign the whole app to a
      minimalist, aesthetic, modern look & feel (current UI looks dated). Plus: Threads/group-chat
      panel, grouped-by-task Activity, Epic→Task board hierarchy, PR view, polished multi-author chat.
- [ ] **Phase 7 — Polish (M13).** Top-tier personas, opt-in live-adapter proof, hardening, docs.
