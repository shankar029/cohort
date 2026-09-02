# Cohort — Development Guide

For contributors and anyone hacking on Cohort itself. For using the app, see the
[USER-GUIDE](./USER-GUIDE.md); for internals, see [ARCHITECTURE](./ARCHITECTURE.md).

---

## Prerequisites

- **Node.js** `^20.19` or `>=22.12` (see `engines` in `package.json`).
- For **real** agent runs: the **GitHub Copilot CLI** installed and authenticated
  (`copilot`), with an active Copilot subscription. Verify with `copilot --version`.
- For E2E: a Chromium install via `npm run e2e:install`.

Most development does **not** need a live model — set `ATEAM_FAKE_SDK=1` (the test
suite does this automatically).

---

## Setup

```bash
npm install
cp .env.example .env      # optional; all vars have sane defaults
```

---

## Run

```bash
npm run dev        # concurrently runs the API server + Vite web dev server
```

- Web (Vite): `http://localhost:5319`
- API + WebSocket (Fastify): `http://localhost:4319` (dev server proxies `/api` and `/ws`)

Production-style single-server run (API serves the built SPA):

```bash
npm run build
npm start          # http://localhost:4319
```

---

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Run server (`tsx watch`) + web (Vite) together. |
| `npm run dev:server` | Server only. |
| `npm run dev:web` | Web only. |
| `npm run build` | Vite production build of the SPA. |
| `npm start` | Production server (serves the built SPA). |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run lint` | ESLint, `--max-warnings 0`. |
| `npm run format` / `format:check` | Prettier write / check. |
| `npm test` | Vitest unit + integration (deterministic, offline). |
| `npm run test:coverage` | Vitest with V8 coverage. |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run e2e` | Playwright E2E (builds web, runs server with the fake adapter). |
| `npm run e2e:install` | Install the Chromium browser for Playwright. |
| `npm run eval` | Run the evaluation harness (`evals/run.mjs`). |

---

## Tech stack

- **Server** — Fastify 5, `better-sqlite3`, `ws`, Zod, TypeScript (run via `tsx`).
- **Web** — React 19, React Router 7, Vite 6, Tailwind 3, `react-markdown` + `remark-gfm`.
- **Agents** — `@github/copilot-sdk` behind the `CopilotAdapter` seam.
- **Tooling** — ESLint 9 + typescript-eslint, Prettier, Vitest 2, Playwright.

---

## Testing model

The LLM lives behind the **`CopilotAdapter`** interface (`src/server/agents/adapter.ts`).
`ATEAM_FAKE_SDK=1` swaps in a deterministic **fake adapter** so the whole system —
including orchestration, gates, and E2E — runs offline and in CI without a live model.

```
tests/
  unit          Pure logic (dag, constraints, store, verification, …)
  integration   Orchestrator + store + git against the fake adapter
  e2e           Playwright, drives the built SPA against a fake-adapter server
  live          Opt-in: exercises the REAL Copilot SDK
```

Run the opt-in live tests (requires an authenticated CLI):

```bash
ATEAM_LIVE=1 npx vitest run tests/live
```

Guidelines:

- Keep unit/integration tests **deterministic and offline** — never depend on a
  live model or network.
- Prefer the fake adapter to simulate agent behavior; extend it rather than reaching
  for a real model in a unit test.
- Add tests for both the happy path and failure modes; the project holds a high
  coverage bar.

---

## Conventions

- **Shared types are the source of truth.** Domain types, REST contracts, and
  WebSocket messages live in `src/shared/` and are imported as `@shared/*` by both
  server and web. Change them there, not in duplicate.
- **The `CopilotAdapter` seam is sacred.** App and tests must not depend on a live
  model directly — go through the adapter.
- **Git safety.** Worktrees always resolve to an **absolute path outside** any
  project or the app repo. `main`/`master` is only updated by an explicit reviewed
  merge. Don't bypass `GitService`.
- **Style.** Match existing patterns; run `npm run lint` and `npm run format:check`
  before committing (`lint` is zero-warnings).
- **Internal naming.** User-facing branding is **Cohort**, but internal identifiers
  stay `ateam`/`ATEAM_*` on purpose — don't rename them (see
  [`PLAN-cohort.md`](../PLAN-cohort.md)).

---

## Before you push

```bash
npm run typecheck && npm run lint && npm run format:check && npm test
# and, when UI or flows changed:
npm run e2e
```

---

## Repository notes

- `PLAN*.md`, `EVAL*.md`, `RUN-*.md`, `BACKLOG.md`, etc. at the repo root are
  **internal working notes** (planning ledgers, eval findings, run monitors), not
  end-user docs. The curated docs live in [`docs/`](.) and the [README](../README.md).
- `data/` holds the local SQLite DB; `dist/` and `playwright-report/` /
  `test-results/` are build/test artifacts.
