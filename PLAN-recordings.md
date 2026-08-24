# Session Recording Plan

**Goal:** Add an opt-in Project Setting that records all agent sessions (full prompts, responses, reasoning, tool calls/results, timing) to a durable, reviewable format so users and the Team Lead can investigate what agents did.
**Status:** done

## Design
- **Setting:** `recordSessions?: boolean` on `ProjectSettings` (default off), toggled in Project Settings.
- **Capture points:** `AgentActor.runTurn` (prompt + response + duration + meta) and `onSessionEvent` (reasoning/tool_call/tool_result, timestamped) — grouped per turn.
- **Storage:** server-side `data/recordings/<projectId>/sessions.jsonl` (one JSON turn per line). Never inside the user's repo. Plus on-demand rendered Markdown export.
- **Review UI:** new "Recordings" page (nav + route) listing turns (agent, work item, time, duration, tool count, prompt preview) → expand for full prompt/response/events. Agent filter. Export JSONL / Export Markdown / Clear buttons.
- **Retention:** keep all while on; "Clear recordings" button. (Rotation deferred.)

## Steps
- [x] 1. `domain.ts` — `recordSessions?` on settings; `RecordedTurn`, `RecordedTurnSummary`, `RecordedSessionEvent` types.
- [x] 2. `shared/api.ts` — `recordSessions` in `updateProjectSettingsSchema`.
- [x] 3. `config.ts` — `recordingsDir`.
- [x] 4. `sessionRecorder.ts` (new) — begin/event/end (serialized append), list/detail/markdown/clear readers.
- [x] 5. `orchestrator.ts` — `recorder` in Deps, `recordingActive` getter, tee in `runTurn` + `onSessionEvent`.
- [x] 6. `index.ts` — construct recorder, wire into OrchestratorManager deps + AppContext.
- [x] 7. `app.ts` — AppContext `recorder`; settings PATCH preserves/sets `recordSessions`; recordings routes (list/detail/export jsonl/export md/clear).
- [x] 8. `web/api.ts` — client methods + export URLs.
- [x] 9. `web/pages/RecordingsPage.tsx` (new) — list + detail viewer + filters + export/clear.
- [x] 10. `web/App.tsx` — nav item + route.
- [x] 11. `web/pages/SettingsPage.tsx` — record-sessions toggle + privacy note.
- [x] 12. Tests — integration: on → records prompt/response; off → nothing; clear empties. Gate (tsc/eslint/prettier/build + unit + E2E).

## Risks & rollback
- Verbose transcripts can grow — mitigated by opt-in + Clear. Best-effort recorder (never throws into a turn).
- Prompts may contain repo content — privacy note in Settings.

## Decisions log
- 2026-08-24 — disk JSONL + rendered MD over a DB table (durable, exportable, greppable, keeps live DB lean). Record everything (Lead + specialists). Full fidelity.
