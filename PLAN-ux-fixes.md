# UX Fixes Plan

**Goal:** Address five reported issues: dashboard color contrast, per-epic threads,
nav responsiveness, unread-thread badge, and notifications reset-on-view.
**Status:** in progress

## Steps
- [ ] 1. Dashboard: In Progress vs To Do colors are too similar in dark mode → give
       To Do a distinct hue.
- [ ] 2. Notifications: visiting the Notifications page resets the unread count
       (mark all read on view).
- [ ] 3. Nav perf: switching pages is sometimes slow/unresponsive → coalesce
       high-frequency WS updates (deltas/events) into one render per frame.
- [ ] 4. Threads: show an unread-message badge on the Threads nav item (like
       Notifications) and clear it when the Threads page is viewed.
- [ ] 5. Threads grouped by epics: give each epic its own discussion thread and
       route that epic's work into it, so the rail groups threads under epics.
       Load a non-main thread's history on selection.

## Risks & rollback
- Step 5 touches orchestrator message routing (server) — highest risk. Guard with
  a helper (`threadForWorkItem`) so standalone tasks still use the main thread;
  add integration test. Keep per-commit so any single step is revertible.

## Decisions log
- 2026-08-25 — To Do → violet (distinct from the blue "working"/in_progress).
- 2026-08-25 — Unread threads tracked client-side via a per-project "seen at"
  timestamp vs. agent-authored chat messages already streamed into the bundle;
  visiting Threads sets seen=now.
