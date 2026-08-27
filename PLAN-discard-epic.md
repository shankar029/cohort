# Feature: Discard / revert an epic (escape hatch)

**Status:** done

**Goal:** Give the user a one-click escape hatch to abort a runaway epic — delete
its board items, stop its agents, throw away its isolated work, and (if it was
already merged) revert the changes from the real repo — so they can start fresh.

## How epics are isolated (why this is safe)

- Each epic runs in a **throwaway clone** under `worktreeRoot/<pid>/<epicId>` on
  branch `ateam/epic-<id>`. The user's real repo (`repoDir`) `main` is **never
  touched until merge** (`approveAndMerge` → `git merge --no-ff`).
- So: **not-yet-merged epic** → discarding = delete the clone + board rows; the
  real repo is pristine. **Merged epic** → additionally `git revert -m 1` the
  merge commit on the base branch (reversible, local, `ateam` identity).

## Design

`POST /api/workitems/:id/discard { revert?: boolean }` → orchestrator
`discardEpic(epicId, { revert })`:

1. Guard hot paths with a `discardedEpics` set so an in-flight turn can't resurrect
   the epic (runWorkItem bails after its ask if the epic was discarded).
2. Remove children + epic from `running`/`awaitingInput`/`armed`; clear
   `epicWorktrees`/`epicPr`/`epicReviewing`/`epicReviewIter`/`reviewContext`.
3. Git: remove the epic clone; if merged → find the merge commit by its
   deterministic message and `git revert`; delete the leftover epic branch.
4. Board: delete child tasks + the epic (publish `workitem.deleted`), delete the
   epic's PRs, close the epic's threads, resolve pending questions from involved
   agents, reset involved agents to idle.
5. Post a chat summary in main + a notification; return a summary object.

## UI

- Board epic card + Chat epic thread header get a **Discard** action (danger),
  behind a confirm dialog. If the epic is merged, the dialog offers "revert the
  merged changes too".

## Tests

- Integration: discard a not-yet-merged epic → children + epic gone, clone
  removed, agents idle, real repo untouched.
- Integration: discard a merged epic with `revert` → base branch gets a revert
  commit undoing the epic's files.
