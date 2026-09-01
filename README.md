# Cohort — Agents Team

A **local web app** that orchestrates [GitHub Copilot SDK](https://github.com/github/copilot-sdk)
agents to get real work done in your repositories. You talk to a single **Team Lead** agent; it turns
each request into an **epic**, decomposes it into stream-tagged tasks on a Kanban board, and assigns
them to a team of principal-level specialists (PM, UX, Frontend, Backend, Data, QA, DevOps, Security,
Docs, …) that work **in parallel** in isolated git worktrees, brainstorm in group threads, keep
living scratchpads, and drive the work through a real **pull-request → review → merge** loop.

> Built with the real `@github/copilot-sdk`. Each agent is an independent, grounded actor (aware of
> the project, environment, and teammates); the Team Lead owns every request end to end.

## Features

- **Projects** — each points at a locally checked-out repo; the team works in that directory.
  Run **many projects/teams in parallel**.
- **Epics & decomposition** — every request becomes an epic; the Team Lead consults the Product
  Manager for outcomes + acceptance criteria, then breaks it into stream-tagged tasks with
  dependencies, assigned for safe parallelism.
- **Per-epic git worktrees** — each epic runs on its own `ateam/epic-<id>` branch in an isolated
  worktree (kept outside your repo), so parallel epics never collide. `main`/`master` is never
  touched until an explicit merge.
- **Pull-request workflow** — when an epic's tasks are done the Lead opens an in-app PR, assigns an
  independent reviewer, and **iterates to a quality bar** (approve / request-changes, capped rounds)
  before a real `git merge --no-ff`.
- **Async, grounded agents** — each specialist is its own SDK session/actor that really talks:
  group **brainstorm threads**, escalation, and multi-author chat.
- **Agent catalog** — 11 highly-specialized agents ready to add, plus create your own custom agent
  (name, description, prompt, tools, **skills**, and **per-agent model**).
- **Kanban board** — create work items (or agents create them), assign to an agent → the agent
  **auto-picks-up** the item, works it, moves it across columns, then **pulls the next** item.
- **Scratchpads** — every agent keeps a living plan + timestamped notes you can watch.
- **Scheduling** — agents can `wait`/`poll`; you can schedule work items for later or make them
  **recurring** (hourly/daily/weekly).
- **Live activity & logs** — watch every agent's messages, reasoning, tool calls, and sub-agent
  lifecycle stream in real time over WebSocket.
- **Escalation** — a specialist's question routes to the Team Lead, which answers or **asks you**;
  your answer flows back and work resumes.
- **Skill discovery** — automatically loads `SKILL.md` skills from your home directory and each
  project, selectable per agent.
- **Workspace-scoped permissions** — agents auto-run inside the repo dir; writes outside are
  blocked. Switch to **manual approval** per project.

## Prerequisites

- **Node.js** `^20.19` or `>=22.12`.
- **GitHub Copilot CLI**, installed and authenticated (`copilot`), with a Copilot subscription.
  The app talks to your local CLI via the SDK — no extra API keys.

Verify: `copilot --version` should print a version, and you should be signed in.

## Install & run

```bash
npm install
npm run dev
```

- Web UI (Vite dev server): **http://localhost:5319**
- API + WebSocket (Fastify): **http://localhost:4319** (the dev server proxies `/api` and `/ws`)

Production-style single-server run (serves the built SPA from the API server):

```bash
npm run build
npm start          # http://localhost:4319
```

Configuration is optional — see [`.env.example`](./.env.example) (port, DB path, default model,
extra skill roots). Copy it to `.env` to customize.

### Offline / UI development without an LLM

Set `ATEAM_FAKE_SDK=1` to use a deterministic fake agent runtime (no Copilot calls). This powers the
test suite and is handy for building UI without spending tokens.

## Models

The app lists the models **actually enabled on your Copilot account** (`/api/models`) and lets you
pick one **per agent**. The default is `auto` (always available); choose a specific model (e.g.
`claude-sonnet-5`, `gpt-5.5`) in the New Project / Add Agent / Settings dialogs.

## How it works

```
Browser (React/Vite)  ──REST + WebSocket──▶  Fastify server
                                              ├─ SQLite (better-sqlite3): projects, agents, epics +
                                              │  tasks, pull requests, threads, notes, events, chat
                                              ├─ Orchestrator (one per project, run in parallel)
                                              │   • per-agent AgentSession actors + mailboxes
                                              │     (independent, grounded, one session per worktree)
                                              │   • epic planning → stream-tagged tasks → assign
                                              │   • GitService: per-epic branch + isolated worktree
                                              │   • PR → review → iterate-to-quality → merge
                                              │   • SchedulerService: wait/poll + scheduled/recurring
                                              └─ CopilotAdapter
                                                  • RealCopilotAdapter  → @github/copilot-sdk
                                                  • FakeCopilotAdapter  → deterministic (tests)
```

The LLM lives behind the `CopilotAdapter` seam so the app and tests never depend on a live model.
Git worktrees always resolve to an absolute temp location (never inside a project or the app repo).

## Testing

```bash
npm test           # unit + integration (Vitest), deterministic, offline
npm run e2e         # Playwright end-to-end (builds web, runs server with the fake adapter)

# Opt-in: exercise the REAL Copilot SDK (requires an authenticated CLI)
ATEAM_LIVE=1 npx vitest run tests/live
```

## Project layout

```
src/shared/   Types + Zod contracts shared by server and web
src/server/   Fastify API, WebSocket, SQLite store, orchestrator, GitService, scheduler,
              Copilot adapters, agent catalog
src/web/      React app (Projects, Chat, Board, Agents, Activity, Pull Requests, Settings)
tests/        unit · integration · e2e · live
```

## Known follow-ups (out of scope for this build)

- Remote git (push + hosted PRs); today all git is local (branches, worktrees, `--no-ff` merges).
- Desktop packaging (Tauri/Electron) for a one-click app.
- Richer permission UI (diff preview before approving writes) and audit export.
- Multi-user auth (currently a local, single-user app).

## License

MIT
