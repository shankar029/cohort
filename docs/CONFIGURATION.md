# Cohort — Configuration Reference

Cohort runs with sane defaults; everything below is **optional**. Environment
variables use the `ATEAM_` prefix and are resolved in `src/server/config.ts`. Copy
[`.env.example`](../.env.example) to `.env` to customize, or export them in your
shell.

Per-project options (model, approval mode, gates, recording, skill roots) are set in
the **Settings** page and stored on the project — those override or complement the
env defaults.

---

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `ATEAM_PORT` | `4319` | HTTP + WebSocket server port. The Vite dev server (`5319`) proxies `/api` and `/ws` to it. |
| `ATEAM_DB` | `./data/ateam.sqlite` | SQLite database file location. |
| `ATEAM_DEFAULT_MODEL` | `auto` | Default model for new agents (overridable per agent). `auto` is always available; pick a specific model enabled on your Copilot account. |
| `ATEAM_SKILL_HOME_ROOTS` | `~/.agents/skills`, `~/.pi` | Comma-separated **extra** home roots to scan for `SKILL.md` skills (added to the built-in defaults). |
| `ATEAM_FAKE_SDK` | `0` | Set `1` to use the deterministic **fake** Copilot adapter (offline, no LLM). Used by the test suite automatically; handy for UI dev without spending tokens. |
| `ATEAM_WORKTREE_ROOT` | `<os-temp>/ateam-worktrees` | Where per-epic git worktrees are created. **Must be outside any project/app repo**; always resolved to an absolute path. |
| `ATEAM_EPIC_CONCURRENCY` | `3` | Max child tasks of **one** epic allowed to run concurrently. Independent streams run in parallel in isolated task clones; integration back into the epic branch is serialized. |
| `ATEAM_MAX_REVIEW_ITER` | `3` | Per-epic review-round budget. After this many rounds with still-open comments, the epic **parks and asks the user** (merge anyway / keep working) instead of silently merging past them. |
| `ATEAM_DESIGN_WAIT_MS` | `45000` | How long a contract-consuming builder (frontend/backend/data) waits for the Architect's shared-interface design before building anyway. Bounded so a stalled design turn never blocks throughput. |
| `ATEAM_DEP_INSTALL_TIMEOUT_MS` | `300000` | Timeout for installing a gate directory's dependencies before build/test gates run there (integrated epic clone / fresh task clones). |

---

## Ports at a glance

| Mode | URL |
| --- | --- |
| Dev — web (Vite) | `http://localhost:5319` |
| Dev — API + WebSocket (Fastify) | `http://localhost:4319` |
| Production (`npm run build && npm start`) | `http://localhost:4319` (serves the built SPA + API) |

---

## Per-project settings (`ProjectSettings`)

Set in the **Settings** page; see `ProjectSettings` in `src/shared/domain.ts`.

| Setting | Meaning |
| --- | --- |
| **Default model** | Default model assigned to this project's new agents. |
| **Approval mode** | `auto-workspace` (agents auto-run tools inside the repo; writes outside blocked) or `manual` (you approve each tool action). |
| **Extra skill roots** | Additional home roots to scan for `SKILL.md`, on top of the built-in defaults. |
| **Paused** | When on, no new agent-driven work starts; in-flight turns finish. |
| **Record sessions** | When on, every agent turn (prompt, response, reasoning, tool calls, tokens) is recorded to disk for review. Off by default. |
| **Test command** | Overrides auto-detection for the QA sign-off build (e.g. `npm test`, `pytest`, `go test ./...`). QA cannot sign off unless this actually passes. |
| **Build command** | Overrides auto-detection (`typecheck` > `build` > `compile`) for the per-task build gate. A build task can't advance to review if this fails. |
| **Acceptance command** | The deterministic **epic-level acceptance probe**, run in the integrated epic clone at finalize (exit 0 = accepted). When unset, Cohort falls back to a committed `.ateam/acceptance.mjs` probe, else an LLM acceptance judge. This is a spec-derived contract check **independent** of the agents' own unit tests. |

---

## Skills

Cohort auto-discovers skills from `SKILL.md` files in:

- built-in home roots (`~/.agents/skills`, `~/.pi`),
- any roots you add via `ATEAM_SKILL_HOME_ROOTS` or a project's **extra skill roots**,
- the project's own repository (`source: 'project'`).

Each discovered skill can be preloaded per agent (in Add Agent / agent edit). See
`src/server/agents/skillScanner.ts`.

---

## Naming note

User-facing branding is **Cohort**, but internal identifiers remain `ateam` /
`ATEAM_*` (env vars, the `.ateam/` workspace prefix, git authors/branches, the DB
path, `ateam-theme` / `ateam:*` localStorage keys, and the package name). This is
deliberate — renaming internals would risk breakage for zero user benefit. See
[`PLAN-cohort.md`](../PLAN-cohort.md).
