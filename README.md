# ateam — Agents Team

A **local web app** that orchestrates [GitHub Copilot SDK](https://github.com/github/copilot-sdk)
agents to get real work done in your repositories. You talk to a single **Team Lead** agent; it
delegates to a team of specialists (UX, Frontend, Backend, QA, DevOps, …) that work in your
checked-out repo, maintain their own task boards, and report their progress live. Create work items
on a Kanban board, assign them to an agent, and watch the agent pick them up and work autonomously.

> Built with the real `@github/copilot-sdk`. The Team Lead is the session's default agent;
> specialists are SDK **custom agents**; delegation, streaming, and escalation use the SDK's native
> sub-agent orchestration.

## Features

- **Projects** — each points at a locally checked-out repo; the team works in that directory.
  Run **many projects/teams in parallel**.
- **Team Lead orchestration** — you only chat with the Lead; it delegates to specialists internally.
- **Agent catalog** — 10 highly-specialized agents ready to add, plus create your own custom agent
  (name, description, prompt, tools, **skills**, and **per-agent model**).
- **Kanban board** — create work items, assign to an agent → the agent **auto-picks-up** the item,
  works it, moves it across columns, then **pulls the next** assigned item.
- **Per-agent task boards** — each agent maintains its own tasks, visible to you.
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
                                              ├─ SQLite (better-sqlite3): projects, agents,
                                              │  work items, tasks, events, chat, questions
                                              ├─ Orchestrator (one per project, run in parallel)
                                              │   • Team-Lead session with workingDirectory = repo
                                              │   • specialists = SDK customAgents (scoped tools,
                                              │     prompt, skills, per-agent model)
                                              │   • autonomous pull-loop + escalation + permissions
                                              └─ CopilotAdapter
                                                  • RealCopilotAdapter  → @github/copilot-sdk
                                                  • FakeCopilotAdapter  → deterministic (tests)
```

The LLM lives behind the `CopilotAdapter` seam so the app and tests never depend on a live model.

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
src/server/   Fastify API, WebSocket, SQLite store, orchestrator, Copilot adapters, agent catalog
src/web/      React app (Projects, Chat, Board, Agents, Activity, Settings)
tests/        unit · integration · e2e · live
```

## Known follow-ups (out of scope for this build)

- Parallel specialists **within** one project via the SDK's Fleet Mode (today: parallel across
  projects; sequential within a project).
- Desktop packaging (Tauri/Electron) for a one-click app.
- Richer permission UI (diff preview before approving writes) and audit export.
- Multi-user auth (currently a local, single-user app).

## License

MIT
