# UX Fixes Plan

**Goal:** Address five reported issues: dashboard color contrast, per-epic threads,
nav responsiveness, unread-thread badge, and notifications reset-on-view.
**Status:** done

## Steps
- [x] 1. Dashboard: To Do → violet (distinct from the blue In Progress). ✅
- [x] 2. Notifications: mark all read on view (badge resets). ✅
- [x] 3. Nav perf: coalesce WS frames into one render per ~40ms (setTimeout, not
       rAF, so headless/background tabs still update); fixed a render loop from an
       unstable `markThreadsSeen` callback that pegged the page. ✅
- [x] 4. Threads unread badge on the nav item, cleared on view; per-project
       "seen at" timestamp in localStorage. ✅
- [x] 5. Per-epic threads: each epic gets a dedicated thread; planning, work,
       completion and review posts route there; non-main thread history loads on
       selection. ✅

## Risks & rollback
- Step 5 touches orchestrator message routing (server) — highest risk. Guard with
  a helper (`threadForWorkItem`) so standalone tasks still use the main thread;
  add integration test. Keep per-commit so any single step is revertible.

## Decisions log
- 2026-08-25 — To Do → violet (distinct from the blue "working"/in_progress).
- 2026-08-25 — Unread threads tracked client-side via a per-project "seen at"
  timestamp vs. agent-authored chat messages already streamed into the bundle;
  visiting Threads sets seen=now.
