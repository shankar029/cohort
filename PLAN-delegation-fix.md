# Fix: Team Lead does all the work instead of delegating

**Status:** done

## What happened (Trip Calculator, Epic 2 "1. Summary / goal")

Diagnosed from the live app (`prj_GT40lUJvnDZw`):

- Epic 2 was created but has **0 child tasks**; the Lead is parked on `needs_input`
  after asking the user *"My implementer agents aren't writing files… and I don't
  have write access myself, so I can't land the change."*
- Epic 1 (12 children across streams) worked fine.

## Root cause

`decomposeEpic` runs, in order:
1. create epic worktree
2. **PM** planning ask (LLM, awaited)
3. **Architect** planning ask (LLM, awaited)
4. **Lead "frame the plan"** ask (LLM, awaited)  ← blocker
5. mechanical fan-out that actually **creates + dispatches one task per stream**
6. plan summary

The mechanical delegation (step 5) is gated behind three open-ended LLM turns.
The Lead's framing turn asked the user a question and **parked**, so step 5 never
ran → no specialist ever got a task → the Lead tried to build/delegate on its own
and stalled. Delegation must never depend on a planning turn completing.

## Fix

1. **Dispatch first.** Move the stream fan-out to run right after the worktree, so
   specialists are assigned and working immediately.
2. **Planning becomes best-effort annotation.** PM / Architect / Lead asks run
   *after* dispatch, each wrapped in try/catch, with tightened prompts: don't
   create tasks, don't implement, don't ask the user blocking questions — just
   enrich the thread and coordinate.
3. **Better titles.** `shortGoal` now skips markdown headings / section headers
   ("Summary", "Goal", numbered `1.`) so an epic pasted as a spec gets a real
   title instead of "1. Summary / goal".

## Tests

- Integration: a build chat whose first line is a markdown section header still
  produces child tasks assigned to specialists, and the epic title isn't the bare
  header.
