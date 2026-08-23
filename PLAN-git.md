# Git Visibility & Completion-Evidence Plan

**Goal:** Give the user + Team Lead real visibility into per-epic git work
(branches, worktrees, commits, files, PRs) and force every agent to post a
structured, evidence-backed completion report so "done but empty branch" is
impossible to hide.

**Status:** done

## Problem
Agents claim a task is complete while the epic branch has no files. There is a
build-gate already, but the completion signal (chat + notify) shows only a prose
summary with no git evidence, and there is no place to see branches/commits/
worktrees per epic. The user wants: (1) a mandatory completion message format
(branch, commits, files, evidence); (2) an explicit git structure per epic; (3)
evidence citation on every task; (4) a new **Git** menu (replacing PR) showing
branches/worktrees/commits/PRs grouped by epic.

## Steps
- [x] 1. Domain types: `GitCommit`, `GitFileChange`, `EpicGit`, `GitSnapshot`.
- [x] 2. `git.ts`: add `commitsAhead`, `filesChanged`, `commitFiles`.
- [x] 3. Orchestrator: structured task **completion report** (branch + commit +
       files + evidence) to main chat; `git` event with structured detail.
- [x] 4. Orchestrator: epic-merge completion report (branch, commits, files).
- [x] 5. Prompt: agents must cite evidence + never claim done without changes.
- [x] 6. `gitSnapshot()` + `GET /api/projects/:id/git`.
- [x] 7. Web `api.gitSnapshot()` + new **Git** page grouped by epic.
- [x] 8. Nav: "Pull Requests" → "Git"; route `pulls`→`git` (redirect old).
- [x] 9. e2e updated (nav "Git" + git-visibility test); `pr-card` preserved.
- [x] 10. Full gate green (44 unit/int + 14 e2e, tsc/eslint/prettier/build).

## Notes / decisions
- Keep the **one-clone-per-epic** model (already isolates epics); "agents merge
  back to the epic branch" == every task commits onto the epic branch in the
  shared epic clone. The Git page makes this flow explicit and visible.
- Git snapshot is fetched on demand (live git queries), not pushed over WS.
- Merged epics: worktree is reclaimed, so commits/files come from the stored PR
  diff; page marks them "merged".
