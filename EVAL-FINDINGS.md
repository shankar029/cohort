# Eval findings — parallel-epics (greenfield) + comprehension (brownfield)

**Date:** 2026-08-25 · **Adapter:** real Copilot SDK (24 models) · **Harness:** `evals/`
**Runs:** `greenfield` (2 parallel epics) and `brownfield` (`sindresorhus/ky`), 45-min windows.

---

## Greenfield — parallel epics — ✅ PASS

Two epics ("Tasks REST API" + "Task tracker Web UI") driven in parallel, full
10-member team. Completed in **~21 min**.

- ✅ **Both epics done, both PRs merged.**
- ✅ **14 real deliverable files on `master`:** `task-store.js`, `app.js`,
  `index.html`, `styles.css`, unit + e2e tests, `.github/workflows/ci.yml`,
  build/serve/check scripts, README, UX docs.
- ✅ **QA gate worked in a real run:** `QA gate: npm run test --silent passed`
  fired **twice** — QA ran the app's actual suite and it passed before sign-off
  (Item 1 validated live).
- ✅ **Per-epic serialization held:** exactly 2 tasks in progress at the peak
  (one per epic) — no shared-worktree clobbering; the two epics ran concurrently.

**Verdict:** parallel-epic delivery and the new QA enforcement both work
end-to-end on a medium greenfield app.

---

## Brownfield — comprehension (`ky`) — ⚠ PARTIAL (did not complete in 45 min)

Task: study the existing repo, then make one small, convention-respecting,
tested improvement.

**What went well — comprehension is genuinely strong.** Agents accurately mapped
`ky`'s architecture (ESM Fetch client; `source/index.ts` factory, `source/core/Ky.ts`
pipeline, hooks as the extension point, exported error classes, `ResponsePromise`).
The Frontend Engineer showed good judgment: *"the architecture has no in-repo
frontend runtime to modify, so I'm documenting the integration boundary instead
of inventing components."* No hallucinated files or invented APIs.

**The gap — it produced analysis, not a change.** Four commits landed on the epic
branch (ux/frontend/backend/devops) but they were **only docs**
(`docs/{backend-architecture,frontend-integration,ux-spec,devops}.md`) — **zero
source or test changes** to `ky`. It timed out with commits on the branch, no PR,
no merge.

### App-level findings (candidates for fixes)

1. **Brownfield decomposition defaults to per-stream documentation, not one
   concrete tested code change.** Given an open-ended "add a small improvement,"
   the Lead fanned it out into ux/frontend/backend/devops tasks and each stream
   wrote its own analysis doc. For a mature library with no explicit feature ask,
   agents play it safe. → *Brownfield work should converge on a single, concrete,
   tested code change (pick one improvement, assign it to the right stream, have
   the rest support), rather than each stream emitting a doc.*
2. **A single brownfield epic + per-epic serialization = long wall-clock.** 8
   sequential tasks, each doing deep study and fighting the repo toolchain, did
   not finish in 45 min. → *Brownfield may warrant fewer, larger tasks, or a
   "study → one change" shape.*
3. **Early time lost fighting the toolchain** (pnpm/xo/ava) via repeated
   powershell/wait loops before real progress.

**Recommendation:** treat finding #1 as the next app fix — steer brownfield
decomposition toward a concrete, tested change. Tracked in `BACKLOG.md`.

> **Update 2026-08-25 — implemented.** Brownfield is now detected (repo already
> has substantial tracked source) and its epics converge on a **single concrete,
> tested build task** assigned to one primary builder (with a "real code + tests,
> not documentation" prompt) instead of a per-stream fan-out. A **docs-only
> deliverable gate** additionally blocks a real-mode build task whose only output
> is markdown. Greenfield keeps its parallel per-stream fan-out. Covered by a new
> integration test.

### Live re-run (2026-08-25) — fix validated

Re-ran `brownfield` against `ky` with the fix:

- **New shape confirmed live:** the epic decomposed into **1 build task + 3
  verifiers** (was 8 tasks / one doc per stream before).
- **Real code landed, not docs.** The Backend Engineer studied the repo, found
  the `test.failing('removes undefined value headers')` case, recognized `ky`'s
  source already supports that behavior, and **promoted the pending test to an
  active one** (`test/headers.ts`) — a small, maintainer-grade change in the
  repo's own style, with cited files + commands. Exactly the intended outcome.
- **Server crashed at t+737s during verification** (last activity was a verifier
  running `ky`'s toolchain via powershell; no error in the server log — likely a
  native abort or the QA gate's heavy `npm install`/test on Windows). The harness
  now **survives a mid-run server death**: the monitor loop catches connection
  failures, ends after ~30s unreachable, and still writes a partial report with a
  `⚠ SERVER CRASHED` banner (previously it threw with no report). Root-causing the
  QA-gate-on-heavy-real-repos stability issue is tracked separately in `BACKLOG.md`.

---

## Harness findings — fixed this commit

The runs exposed three measurement bugs in the eval harness (now fixed):

1. **False-positive auth detection.** The greenfield report flagged an "auth
   issue" because an agent legitimately wrote `401 Unauthorized` handling and the
   WS-content regex matched it. → Auth is now judged **only from the server log**
   (warm-up prints a specific hint when unauthenticated), never from agent/tool
   content.
2. **Brownfield deliverable count was meaningless.** It counted the whole
   pre-existing repo tree (`63` for `ky`). → Deliverables are now measured as
   **files the team added/changed**: new files on the default branch vs a
   pre-run baseline, plus files changed on the epic-branch clones.
3. **Loose QA-signoff signal.** Fuzzy keyword matching. → Now keys off the
   authoritative `QA gate: … passed` event.

---

## Bottom line

- **Greenfield delivery + parallel epics + QA enforcement: solid.** The core
  pipeline works on a real medium app.
- **Brownfield comprehension: strong; brownfield *execution*: needs steering**
  toward concrete tested changes instead of analysis docs. That's the highest-value
  next correctness fix.
