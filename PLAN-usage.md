# Time & Token Usage Tracking Plan

**Goal:** Track wall-clock time and model tokens each agent spends on each work item, and surface it across the UI.

**Status:** done

## Data model

`work_usage` ledger, one row per (workItem, agent):

- `id` = `${workItemId ?? '_none'}::${agentId}` (PK, upsert key)
- `project_id`, `work_item_id` (nullable — general Lead chat), `agent_id`
- `input_tokens`, `output_tokens`, `time_ms`, `turns` (accumulated)
- `updated_at`

Rollups are computed client-side:

- **per item** = sum rows for the item (+ its children, for epics)
- **per agent** = sum rows for the agent
- **project total** = sum all

## Token/time source

- Real SDK emits `assistant.usage` per model call → `inputTokens`, `outputTokens`,
  `duration`, `model`. Surface via a new `SessionEvent` kind `usage`.
- Fake adapter synthesizes a usage event per `ask` so fake mode + tests show
  non-zero numbers.
- Wall-clock **time** is measured around each `session.ask` turn in the orchestrator
  (includes tool/think/wait time — "agent effort"), attributed to the turn's work item.

## Steps

- [x] 1. `domain.ts`: `UsageEntry` interface.
- [x] 2. `database.ts`: `work_usage` table + index.
- [x] 3. `store.ts`: `recordUsage()` (upsert-accumulate) + `listUsage()`.
- [x] 4. `ws.ts`: `usage.updated` event.
- [x] 5. `adapter.ts`: `usage` SessionEvent kind.
- [x] 6. `realAdapter.ts`: subscribe `assistant.usage` → emit usage event.
- [x] 7. `fakeAdapter.ts`: synthetic usage per ask.
- [x] 8. `orchestrator.ts`: record tokens (usage event) + time (runTurn wall-clock);
       publish `usage.updated`.
- [x] 9. `app.ts`: include `usage` in GET /api/projects/:id.
- [x] 10. `state.tsx`: bundle `usage[]`, SET_BUNDLE, `usage.updated` reducer.
- [x] 11. Shared web helpers: `formatTokens`, `formatDuration`, usage aggregations.
- [x] 12. Surfaces: Board cards + detail modal, Agents list, Agent detail, Dashboard.
- [x] 13. Tests: store unit + orchestration integration (usage recorded on delivery);
        E2E assertion of a usage stat.

## Risks

- Multiple agents on one epic → wall-clock times sum to "cumulative effort", may
  exceed real elapsed. Intentional; labelled "time spent".
- Token counts absent for some model calls (fields optional) → treat as 0.
