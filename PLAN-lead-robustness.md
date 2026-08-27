# Team Lead Robustness Plan

**Goal:** Make the Team Lead a persistent, self-healing manager that drives every
project to closure without the user having to manually poke it.

**Status:** done

## Root causes

- `leadTick` (every 15s) runs assign → drive → supervise, but **epic closure
  (`maybeFinishEpic`) is only event-driven** on task completion. If that trigger is
  missed / an epic reaches "all children landed" via another path, the epic sits
  `in_progress` forever. → user must manually re-poke the Lead.
- Nothing escalates when the board genuinely **stalls** (open work, nobody working,
  no pending user question) — the Lead just goes quiet, so it *looks* idle.

## Changes

1. **Closure self-healing** — `driveEpicsToClosure()` in every `leadTick`: for each
   open epic, recompute progress and re-run the idempotent `maybeFinishEpic` so an
   epic with all children landed always advances to review → merge → done.
2. **Stall watchdog** — `watchForStall()`: when there is open work, nothing running,
   no agent working, and no pending user question, and the board hasn't moved for
   `STALL_MS` (default 120s), the Lead posts a concise diagnosis to main chat and —
   only when it genuinely can't self-heal (e.g. no specialists to do the work) —
   raises a notification. Deduped so it stays low-noise.
3. **Board-activity tracking** — `lastBoardActivityAt`, bumped on any status move /
   assignment / run start, so the watchdog can tell "waiting" from "stuck".

## Tests

- Integration: an epic whose children are all `done` but left `in_progress` gets
  closed by the periodic tick alone (no task-completion event).
- Integration: a project with open tasks but no specialists raises a stall
  escalation notification.

## Risks

- Watchdog noise → mitigated by dedupe signature + only notifying when unrecoverable.
- Re-running `maybeFinishEpic` each tick → it's idempotent and guarded by
  `epicReviewing`, so no double-merge.
