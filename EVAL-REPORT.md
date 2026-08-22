# ateam — Capability Evaluation Report

> **RESOLUTION (all findings fixed + validated):** every SEV below was fixed and the
> delivery pipeline was re-validated end-to-end with the **real** Copilot SDK: the Team
> Lead orchestrates only, a specialist writes real code in its isolated epic clone, it is
> committed to the epic branch, QA verifies, the PR merges, and the file lands on `master`.
> Commits: `d81e075` (SEV-1..4), `c78433b` (clone isolation + Lead-orchestrates-only +
> clone-write permission + board is system-owned), `9f4a707` (regression tests),
> `842a5a1` (chat UX). Root cause of the orphaned writes was two-fold: (a) git *worktrees*
> are incompatible with the SDK's workspace-root resolution (a worktree's `.git` file
> points back to the main repo) — replaced with isolated local **clones**; and (b) the
> **Team Lead was implementing code itself** in `repoDir` — now hard-blocked from all
> file writes. See `TESTING-PLAN.md` for the fix map.

**Date:** 2026-08-21
**Setup:** isolated real-SDK instance (port 4455, own DB), scratch git repo
`C:\Code\Projects\ateam-eval-urlshortener`, full 8-member team (Team Lead, PM,
Architect, Frontend, Backend, QA, DevOps, Docs). Adapter: **copilot-sdk (real)**.
**Requirement:** medium-complex URL-shortener (REST API + click counts + validation +
health endpoint + minimal web UI + tests + README).
**Run window:** ~40 min; observed via API/DB/WS + git inspection of the epic worktree.

---

## TL;DR

The **orchestration layer is genuinely strong** — real planning, sensible decomposition,
multi-agent discussion with conflict resolution, principal-level judgment, Lead ownership
(status heartbeats, decisions, supervision), and honest self-blocking by QA/Docs. When
agents write code, the **quality is high** (the frontend is accessible + XSS-safe).

**But delivery is broken by one SEV-1 bug:** agents write real source files into the
project's `repoDir` (main checkout, on `master`) instead of the **epic worktree**, so the
per-task commit (`git add -A` in the worktree) captures only `.ateam/tasks/*.md` markers.
Net result after 40 min: **near-zero code committed to the branch, no PR, no merge** —
while the board shows tasks at "review / 100%" and the epic at 84%.

---

## What worked (real capability)

1. **Planning.** PM locked a crisp 5-endpoint contract (`POST /api/links`, `GET /api/links`,
   `GET /:code` redirect, health, …). Architect produced an MVP design. The Lead posted a
   clear plan **with an explicit dependency chain** (architecture → backend contract →
   frontend/QA in parallel → devops → PR with QA sign-off).
2. **Decomposition.** Sensible stream tagging: `architecture, backend, frontend, qa,
devops, docs`.
3. **Communication & conflict resolution.** Real cross-agent discussion; the Lead
   convened a **group discussion thread** and recorded decisions ("converged on the PM
   contract, resolving route and duplicate-policy conflicts", "keep the frozen contract as
   the single source of truth", "Node >=20"). Status heartbeats fired (0% → 82% → 84%).
4. **Judgment / honest escalation.**
   - **Docs** refused to invent docs for non-existent code and escalated a precise question
     ("only a placeholder README and no source files yet…"). Correct call.
   - **QA** detected the empty branch and **blocked**: "QA verification blocked/fail:
     assigned worktree branch contains only README.md, .gitignore, and .ateam…". Excellent
     — the review gate's _intent_ works.
5. **Code quality (when written).** `app.js` (frontend) is IIFE + strict mode, accessible
   (`aria-invalid`, focus management, `rel="noopener noreferrer"`), XSS-safe
   (`createElement`/`replaceChildren`, no `innerHTML`), defensive field normalization,
   proper loading/disabled/error states. Principal-level.
6. **Guardrails held.** `master` never touched; worktree-per-epic on `ateam/epic-…`;
   commits under the `ateam` identity.

## What's broken (defects, by severity)

### SEV-1 — Agents write code to the wrong directory (worktree/cwd mismatch)

The frontend agent's own note diagnosed it: _"the file patch landed in the repository path
shown by the project metadata, while shell validation runs in the isolated worktree."_
Real artifacts (`app.js` 3.7 KB, `index.html`, `styles.css`) ended up as **untracked files
on `master` in `repoDir`**, never in the worktree/branch. The task commit only contained
`.ateam/tasks/<id>.md`. **This makes the whole pipeline deliver ~nothing.**
→ Fix: run each agent (and its file-writing/shell tools) with **cwd = the epic worktree
path**, not `repoDir`. The worktree path is already computed for reviews (`wt.path`); thread
it into the working turn and tool execution.

### SEV-2 — Duplicate re-decomposition

The epic was decomposed **multiple times**: 17 work items where ~6 are the clean first wave
("Implementing URL shortener backend"), ~5–6 are a second wave titled with the **raw
requirement string** ("[backend] Build a URL shortener service. Requirements: (1)…"), plus a
nested `[epic] Delivering URL shortener MVP` item and a QA verify. Wasteful and confusing.
→ Fix: make `planEpic` idempotent; identify what re-triggered decomposition (manager loop /
resumeWork / a second `planEpic`) and guard it. Use concise generated titles, never the raw
requirement.

### SEV-2 — Progress/completion decoupled from artifacts

Tasks reach `review / 100%` and the epic rolls to 84% **with no committed code**, at the same
moment QA reports the branch is empty.
→ Fix: a task may only advance to review/done if the worktree has **real changed files**
(diff excluding `.ateam/`) or QA passes. Otherwise fail → repair.

### SEV-3 — Under-modeled cross-stream dependencies

Docs/DevOps/QA ran in parallel with Backend rather than depending on it; Docs had to
escalate. Backend produced nothing runnable, so the good frontend calls a non-existent API.
→ Fix: encode dependencies (docs & qa dependOn backend+frontend; devops after build).

### SEV-3 — No recovery when QA blocks

QA correctly blocked on the empty branch, but the loop didn't re-run the builder in the
correct worktree; the epic stalled (~40 min, no PR).
→ Fix: on QA-blocked/empty-branch, re-dispatch the responsible builder task (in the correct
cwd) as a repair.

### SEV-4 — Worktree GC

~40 stale worktrees from prior runs accumulate under `%TEMP%/ateam-worktrees`.
→ Fix: prune worktrees on epic merge/close and on startup.

## Delivered artifacts (actual)

| Stream   | Committed to branch                | Written to `repoDir` (orphaned)             | Runnable?      |
| -------- | ---------------------------------- | ------------------------------------------- | -------------- |
| Frontend | `.ateam/tasks` marker only         | `index.html`, `styles.css`, `app.js` (good) | No API to call |
| Backend  | `.ateam/tasks` marker only         | none (no `package.json`/server)             | No             |
| QA       | marker only; **blocked** correctly | none                                        | No tests       |
| DevOps   | marker only (narration)            | none                                        | No             |
| Docs     | marker only; escalated correctly   | README unchanged                            | No             |

## Prioritized fixes

1. **(SEV-1) Agent cwd = epic worktree** for the working turn + file/shell tools. _Single
   highest-impact fix — unlocks actual delivery._
2. **(SEV-2) Idempotent decomposition** + concise titles.
3. **(SEV-2) Gate completion on real diff / QA pass**; no "100%" for narration.
4. **(SEV-3) Cross-stream dependencies** + **repair loop** on QA block.
5. **(SEV-4) Worktree pruning.**

## Note

The isolated eval server was stopped after capture to avoid runaway token use. Orphaned
files remain in `C:\Code\Projects\ateam-eval-urlshortener` (untracked on `master`) as
evidence for the SEV-1 fix; delete when no longer needed.
