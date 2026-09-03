# Live Real-SDK Parallelism Validation Plan

**Goal:** Prove — under the REAL `@github/copilot-sdk` — that Cohort runs (a) two
epics concurrently within one project and (b) two projects concurrently, each
driven to a real merge.
**Status:** done ✅ 2026-09-02 — both claims validated under the real SDK.

## Why
Fake-adapter integration tests already cover both scenarios, and a single live
agent session works. But no test has driven *concurrent* epics/projects to merge
under a real model. We can't claim it works until we've seen it.

## Setup (isolated, non-polluting)
- Server: `tsx src/server/index.ts` with REAL adapter (ATEAM_FAKE_SDK unset).
- Env isolation: `ATEAM_PORT=4399`, temp `ATEAM_DB`, temp `ATEAM_WORKTREE_ROOT`,
  temp `ATEAM_RECORDINGS_DIR`. Scratch dir + repos live OUTSIDE the cohort repo.
- Per project: `testCommand` + `acceptanceCommand` = `node --test` (deterministic,
  no npm deps, avoids LLM-judge cost + probe authoring).

## Scenarios (one run proves both)
- **P1 — parallel epics:** one project, team [backend, frontend, qa, reviewer].
  Fire TWO independent briefs → Epic A (`src/strings.js`) + Epic B (`src/numbers.js`).
  Distinct new files ⇒ clean concurrent merges into one repo.
- **P2 — parallel projects:** second project (own repo), team [backend, qa, reviewer],
  one brief (`src/greet.js`), running concurrently with P1.

## Evidence captured (real @github/copilot-sdk, 22 models, port 4399)
- [x] Peak DISTINCT epics active in P1 = **2** (first at 3:05:20pm).
- [x] Peak DISTINCT projects active = **2** (first at 3:05:20pm).
- [x] All 3 epics reached `done`; P1 = **2 PRs merged**, P2 = **1 PR merged**.
- [x] Real deliverables on each base branch: repo-p1 `src/strings.js` + `src/numbers.js`
      (+tests) via two `ateam: merge ateam/epic-*`; repo-p2 `src/greet.js` (+tests).
- [x] Merged code actually runs: `node --test` → repo-p1 **30 pass / 0 fail**,
      repo-p2 **12 pass / 0 fail**.
- [x] Review loop fired for real: QA/reviewer filed BLOCKER comments that were fixed
      and re-driven before merge (visible in git log).
- Run took ~13 min wall-clock; P1=`prj_Rbem2bIrcoay`, P2=`prj_KjDhlZYWWs5p`.
- Harness + logs + repos: `C:\Code\Projects\ateam-live\` (outside the repo).

## Harness behavior
- Wait for `/api/health`, create projects/agents, PATCH settings, fire chats.
- Poll every 8s (bounded ~25 min). Auto-answer any escalation with a sensible
  default so a clarify round never stalls the run.
- Verdict SUCCESS when all epics done + merged; else report partial with evidence.

## Steps
- [x] 1. Write harness (`run.mjs`) in scratch dir.
- [x] 2. Start isolated real-SDK server (background), confirm health + models.
- [x] 3. Run harness; stream the timeline.
- [x] 4. Collect evidence (statuses, PRs, git trees, concurrency peaks).
- [x] 5. Tear down server; write verdict here.

## Verdict
**Parallel epics (one project) and parallel projects both WORK under the real SDK.**
Two epics in P1 and the two projects were observed running concurrently, and all
three epics were driven to a real reviewed `--no-ff` merge with passing tests.

## Risks
- Token/time cost (real multi-agent turns) — mitigated by tiny, dep-free briefs.
- Agent may over-engineer/ignore constraints — briefs are crisp + "don't ask"; the
  gates catch drift; harness auto-answers escalations.
- Non-determinism — we assert observed concurrency peaks + terminal merges, retriable.

## Decisions log
- Combined both claims into ONE run (P1 two epics + P2) to minimize token cost.
- Set test/acceptance command to `node --test` to keep gates deterministic + cheap.
