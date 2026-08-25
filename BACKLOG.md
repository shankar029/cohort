# A Team — Backlog

Deferred ideas not yet scheduled. Newest first.

---

## Steer brownfield decomposition toward one concrete tested change

**Status:** ✅ implemented 2026-08-25 (commit follows this doc)
**Added:** 2026-08-25
**Context:** From the `brownfield` eval (see `EVAL-FINDINGS.md`). On an existing
mature repo (`ky`), the team's comprehension was excellent but execution
produced only per-stream analysis DOCS (ux/frontend/backend/devops each wrote a
`.md`) and zero source/test changes — then timed out with no PR.

**Idea:** when an epic targets a non-empty/brownfield repo and the ask is
open-ended, decomposition should converge on a SINGLE concrete, tested code
change rather than fanning out one analysis task per stream:
- Detect brownfield (repo already has substantial tracked source at project
  creation) and adjust the Lead's decomposition prompt.
- Shape work as "study → pick ONE improvement → implement it with tests in the
  repo's existing style → review", assigning the change to the best-fit stream
  and letting others support, not each produce a doc.
- Bias the deliverable gate for brownfield build tasks toward source/test files
  (a `.md` in `docs/` alone should not satisfy a build task).
- Consider fewer, larger tasks for brownfield to fit the wall-clock (per-epic
  serialization makes many small sequential tasks slow).

**Scope:** orchestrator `decomposeEpic` prompt/shape + a brownfield signal +
possibly the deliverable gate. Needs its own PLAN + confirm before building.

---

## Parallel intra-epic execution (per-task branch → merge back)

**Status:** proposed / not started
**Added:** 2026-08-24
**Context:** Follow-up to `6c05aff` (serialize tasks within an epic to stop file
overwrites). Serialization is correct but removes intra-epic parallelism. This
would bring parallelism back safely.

**Idea:** give each task its own clone off the epic branch
(`ateam/epic-<id>` → `ateam/epic-<id>/<taskId>`), let agents work in isolation
in parallel, then merge each task branch back into the epic branch when done.
Reuses existing `git.ts` clone machinery (`cloneEpic`, `commitWork`,
`mergeEpic`). Keep it **opt-in, default off**; serialization stays the safe
default (small/greenfield projects share root files and are safer serial).

**The hard part is the merge, not the worktrees:**
- **Textual conflicts** — two agents edit the same file (e.g. `package.json`,
  `src/calc.js`). Git can't auto-resolve; needs an agent-driven resolver.
- **Semantic conflicts** — branches merge cleanly but the combined result is
  broken (caller/signature mismatch across streams). Only tests/review catch
  this, so a post-merge verify pass is required.
- Small greenfield repos are the worst case (one `package.json`/`calc.js`, every
  agent touches shared root files → ~100% conflict rate). Pays off on larger
  repos with clear module boundaries.

**What "doing it right" requires:**
1. Per-task clone off the epic branch (reuse `cloneEpic`).
2. **Serialized integration step** — a merge lock; only one branch merges into
   the epic branch at a time (merges are fast, so this is fine). Work is
   parallel; integration is inherently sequential.
3. Conflict strategy — recommended **(a) ownership-partition first, (b) serial
   fallback:**
   - (a) At decomposition, assign each stream disjoint path ownership
     (frontend→`src/ui/**`, backend→`src/api/**`, docs→`docs/**`) and enforce
     it → conflict-free merges by construction. Shared files (`package.json`)
     still need a designated owner.
   - (b) On the rare overlap/conflict, fall back to serial for that task: rebase
     its branch onto the updated epic branch and re-run the agent to resolve.
4. Post-merge verify pass (reuse QA/reviewer gates) to catch semantic breakage —
   run after integration, not per-branch.

**Scope (wide-reaching — needs its own PLAN.md + confirm before building):**
`git.ts` (per-task clone + merge-with-conflict-detection + merge lock),
`orchestrator.ts` (scheduling: parallel drive within an epic behind the opt-in
flag, integration queue, conflict fallback), epic decomposition (path-ownership
assignment), `ProjectSettings` (opt-in toggle), tests (parallel merge,
conflict → serial fallback, semantic-conflict caught by verify).

**Recommendation when picked up:** build as opt-in "parallel execution" mode,
partition-first with serial fallback.
