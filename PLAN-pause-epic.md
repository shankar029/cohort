# Pause/Resume + Board Epic Creation Plan

**Goal:** Add (1) a project-level Pause/Resume so the user can stop agents to change
direction, (2) a "New epic" option on the Board, and (3) enforce that epics are
only ever owned by the Team Lead.
**Status:** done

## Steps
- [x] 1. Domain/schema: `ProjectSettings.paused?: boolean`; `createWorkItemSchema.kind`.
- [x] 2. Orchestrator: extract `decomposeEpic(epic, content)` out of `planEpic`.
- [x] 3. Orchestrator: `paused` gates + `setPaused()`, `onEpicCreated()`, resume decomposition.
- [x] 4. API: pause/resume routes; epic branch in POST /workitems; force Lead owner.
- [x] 5. UI: Pause/Resume button + paused indicator; "New epic" toggle on Board.
- [x] 6. Tests + full gate: 64 unit/integration @87.08% + 14 e2e.
- **Pause = soft-stop.** No new agent-driven work starts (assignment, pickup,
  runWorkItem, decomposition, group chat kickoff). Chat with the Lead still works
  so the user can redirect. In-flight turns finish naturally (no mid-turn abort —
  the session API only exposes ask/dispose). Persisted in `ProjectSettings.paused`
  so it survives restarts.
- **Resume** clears the flag, decomposes any childless non-done epics created while
  paused, and pokes the manager loop to resume ready work.
- **Board epic** creates a Lead-owned `kind:'epic'` item, then the Lead plans +
  decomposes it exactly like a chat-originated epic (unless paused → deferred to
  resume).
- **Epic ownership** is forced to the Lead on create + update, server-side; the UI
  create-epic form has no assignee (auto Lead) and epics show a fixed owner.

## Steps
- [ ] 1. Domain/schema: `ProjectSettings.paused?: boolean`; `createWorkItemSchema.kind`.
- [ ] 2. Orchestrator: extract `decomposeEpic(epic, content)` out of `planEpic`.
- [ ] 3. Orchestrator: `paused` gates (leadTick/runWorkItem/onItemAssigned/pokeLead/
        chat-kickoff); `setPaused()`, `onEpicCreated()`, resume decomposition.
- [ ] 4. API: `POST /projects/:id/pause` + `/resume`; epic branch in POST /workitems;
        force Lead owner for epics on create + PATCH.
- [ ] 5. UI: Pause/Resume button (sidebar footer) + paused banner; "New epic" on Board
        (kind toggle in create modal); epic form has no assignee.
- [ ] 6. Tests: pause halts pickup + resume restarts; board epic decomposes + is
        Lead-owned; epic reassignment to specialist is rejected. Full gate.

## Risks & rollback
- `planEpic` is central; refactor must preserve behavior — covered by existing epic
  integration test. Revert = git checkout the two commits.
