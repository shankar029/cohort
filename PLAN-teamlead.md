# Team Lead Supervision + Agent Task Structure + Testing Mandate — Plan

**Goal:** Make the Team Lead a first-class manager (invoke/restart agents, not just
nudge), group chat threads per epic, give agents an anti-hallucination task
structure (split each work item into checkable sub-tasks), and enforce a testing
discipline (unit + integration + ≥80% coverage; QA writes real end-to-end tests
and signs off only after they pass).

**Status:** done

## Scope (5 features)

### A. First-class Lead → specialist invocation + session restart
- Replace the passive `superviseAgents()` nudge with an active manager step:
  - When an agent is `blocked` or its assigned task is stalled, the Lead **invokes
    the agent directly** with a concrete directive (resume / here's the decision).
  - Track per-agent trouble signals (empty builds, errors, repeated stalls,
    ignored nudges). Past a threshold the Lead declares the session
    **unrecoverable** and **restarts it**: dispose the actor's Copilot session,
    drop it, spin up a fresh one, and re-drive the work item once.
  - If it still fails after a restart, escalate to the user (existing path).
- New: `AgentActor.restart()` / `orchestrator.restartAgentSession(agentId)` —
  dispose + remove from `actors` map (next `actor()` call builds fresh), emit a
  `system` event + notification, reset the agent status to `idle`.

### B. Group chat threads per epic
- Chat "Threads" rail groups discussions under their epic (collapsible), with the
  main Team Lead channel pinned on top and a "General" bucket for unlinked threads.
- Thread → epic resolsolved from `thread.workItemId` (epic itself, or the task's
  `parentId`). Ensure orchestrator group/dm threads always set `workItemId`.

### C. Per-work-item sub-task structure (anti-hallucination)
- When a specialist picks up a work item, **first** split it into a short,
  concrete checklist of sub-tasks, persisted as `AgentTask`s under
  agent → epic → work item (the `AgentTask` model + AgentDetailPage grouping
  already exist). Then it executes, knocking each sub-task from `todo`→`done`.
- Mechanism: orchestrator-driven two-phase run in `runWorkItemInner`:
  1. **Plan ask** → agent returns a checklist; parsed + saved as sub-tasks.
  2. **Execute ask** (with the checklist embedded) → builds, ticks sub-tasks done.
- Fake adapter emits a deterministic `[[PLAN: a; b; c]]` marker so this is testable
  without a live LLM. Real adapter: prompt asks for a checklist first.

### D. Testing mandate (unit + integration + ≥80% coverage) for agent output
- Strengthen builder catalog prompts (frontend/backend/etc.) + the task base
  prompt + the definition-of-done: every build sub-task must add unit +
  integration tests and keep coverage ≥80%, leaving the build green; completion
  evidence must cite the tests added + how run.
- (Enforcing arbitrary target-repo coverage at runtime is fragile, so this is
  prompt + definition-of-done + evidence, not a hard runtime gate.)

### E. QA writes real end-to-end tests + sign-off gate
- Strengthen the QA catalog prompt: write **end-to-end** tests that exercise each
  feature the way an end user does; pick an E2E library from what the repo already
  uses, else choose one; **sign off only after the E2E tests actually pass**, with
  evidence. QA's verify task stays dependency-gated on the builder tasks (exists).

### F. Tests + coverage for THIS work (my own changes)
- Add `@vitest/coverage-v8`; add a `test:coverage` script + an 80% threshold on the
  server/shared modules I touch.
- Unit tests: session-restart trigger logic, sub-task parsing. Integration tests:
  Lead restarts an unrecoverable agent and the work still completes; sub-tasks are
  created + completed for a work item. E2E: chat threads grouped by epic; agent
  detail shows sub-tasks under the work item.

## Key design decisions (please confirm or adjust)
1. **Sub-tasks are orchestrator-driven** (plan ask → persist → execute), with a
   fake-adapter `[[PLAN:]]` marker — deterministic + testable. _(vs. giving the LLM
   self-managed add_subtask tools, which the fake adapter can't exercise.)_
2. **Restart trigger = 2 unrecoverable signals** (e.g. two empty builds / errors /
   ignored nudges) → dispose session + fresh session + re-drive once; still failing
   → escalate to user.
3. **Testing/coverage is prompt + definition-of-done + evidence**, not a hard
   runtime gate against the target repo (which would be brittle across arbitrary
   repos). QA sign-off is gated on the E2E tests passing (evidence-cited).
4. **Thread rail = collapsible epic groups**, main pinned on top, "General" bucket.

## Steps
- [x] 1. domain/store/db: reused AgentTask; added restart + subtask helpers.
- [x] 2. orchestrator A: active supervision + `restartAgentSession` + trouble counters.
- [x] 3. orchestrator C: two-phase runWorkItemInner (plan → sub-tasks → execute).
- [x] 4. fakeAdapter: `break this work item into a short checklist` → deterministic list.
- [x] 5. catalog D/E: builder testing mandate + QA end-to-end + sign-off prompts.
- [x] 6. web B: ChatPage thread grouping per epic; AgentDetail work-item nesting.
- [x] 7. tests F: integration (sub-tasks, restart) + e2e (workitem-group); coverage 85%.
- [x] 8. Full gate green (tsc/eslint/prettier/vitest+coverage 85% /playwright 14).

## Risks
- Two-phase runs add one extra LLM round per task (cost/latency) — acceptable for
  quality; fake adapter unaffected.
- Session restart must never touch a closed DB or double-drive an item (guard with
  existing `running`/`disposed` sets).
- Coverage threshold scoped to touched modules to avoid failing on legacy files.
