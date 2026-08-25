# ateam eval harness

Drives a **real** ateam server through the REST API + WebSocket to measure
whether the multi-agent team actually **delivers** — real files committed, QA
gates enforced, PRs merged — on medium-scale greenfield and brownfield work.

Everything runs in an **isolated** instance (its own port, SQLite DB, and
worktree root under the OS temp dir). It never touches this repo's data or git
state. Reports land in `evals/reports/` (git-ignored).

## Requirements

- Node 24+ (built-in `fetch`).
- For **real** runs: the Copilot CLI must be authenticated. Run `copilot` once
  and sign in. The harness prints a loud warning if it detects auth failures.
- `git` on PATH.

## Usage

```bash
# Self-test the harness with the fake adapter (deterministic, no auth, ~15s):
node evals/run.mjs smoke --fake

# Real-SDK runs (must be signed in):
npm run eval -- greenfield          # 2 parallel epics: REST API + web UI
npm run eval -- brownfield --repo=https://github.com/OWNER/REPO.git
npm run eval -- smoke               # quickest real end-to-end check
```

### Flags

| flag | meaning | default |
|------|---------|---------|
| `--fake` | use the deterministic fake adapter (no auth) | off (real SDK) |
| `--port=N` | server port for the isolated instance | `4600` |
| `--timeout=MIN` | max minutes to wait for delivery | per-scenario (15–45) |
| `--model=NAME` | default model override (real mode) | `auto` |
| `--repo=URL\|PATH` | brownfield target (cloned/copied into scratch) | per-scenario |
| `--ref=GITREF` | brownfield checkout ref | none |

## Scenarios

- **`smoke`** — tiny greenfield task (word-count page). Fastest full pipeline
  check. Team: frontend + QA.
- **`greenfield`** — medium-scale app as **two parallel epics** (a tested REST
  task API, and an accessible web UI that consumes it). Full 10-member team.
  Validates parallel-epic delivery, QA gating, and merges.
- **`brownfield`** — a focused, convention-respecting change on an **existing**
  medium repo. Validates that agents study and match the established structure,
  style, and design patterns instead of reinventing. Point it at any repo with
  `--repo=`; a local path is copied into scratch so the original is never
  mutated.

## What it scores

Each run writes `evals/reports/<run>.md` (+ `.json`) with:

- epics done / total, PRs raised / merged, deliverable files on the default
  branch, QA sign-off observed, and any auth failure;
- per-scenario **acceptance checks** (pass/fail);
- the Team Lead chat transcript (last 40 messages) and pointers to the raw WS
  event log + server log in the scratch dir.

Process exit code is `0` only if the scenario completed within the window and
all acceptance checks passed — so runs are CI-friendly.

## Interpreting results

These are **discovery** runs against a non-deterministic LLM. A red acceptance
check is a lead to investigate (read the report's chat + the scratch
`events.jsonl` + `server.log`), not necessarily a harness bug. Findings feed
fixes back into the app (see `PLAN-correctness.md`).

## Layout

- `harness.mjs` — engine: server lifecycle, API/WS client, monitor, scoring,
  repo helpers.
- `run.mjs` — CLI + scenario registry (`smoke`, `greenfield`, `brownfield`).
- `reports/` — generated reports (git-ignored).
