# UI Batch Plan — epic grouping, collapsibles, filters, dashboard

**Goal:** deliver 5 UX improvements (epic-grouped conversations, collapsible Git
sections, epic filters on Notifications/Git/Activity, dashboard "in progress now").
**Status:** done — all 5 shipped; tsc/eslint/prettier/vitest(171)/vite build + e2e(15) green
**Scope:** mostly frontend; one small backend change (item 1a) that restarts the
`tsx watch` server (safe now — the Snippet Vault epic already merged).

Data already available (no backend needed unless noted):
- `Thread.workItemId`, `AgentEvent.workItemId`, `Notification.workItemId` — all
  resolvable to an epic via `task.parentId`.
- `WorkItem.assigneeAgentId` + `status` — gives each agent's current item.
- `ChatPage.epicOf()` already resolves a thread → its epic.

---

## Item 1 — group ALL epic conversations under the epic + epic-aware "New conversation"

**What I think (recommendation):**
- **1a (agent-created discussions):** they land in **GENERAL** only because the group
  chat was requested during an early turn where `workItemId` was `null` (repo
  inspection, pre-task). Fix in `maybeHandleGroupChatRequest` / `runGroupChat`:
  resolve the epic from, in order — (i) the turn's `workItemId` (task→parent epic),
  (ii) the requester's currently-assigned in-progress item's epic, (iii) if exactly
  one epic is active, use it. Link the thread to that epic. → agent discussions nest
  under their epic automatically. *(backend; server restart)*
- **1b (New conversation):** I recommend **keeping the conversation-first model** (a
  conversation is how an epic is born) rather than forcing "create an epic first."
  Turn "New conversation" into a tiny popover:
  - **"Start something new"** (default) → current behavior (a `dm` that becomes a new
    epic from your first message).
  - **Under an existing epic ▾** → pick an epic; creates a `dm` linked to that epic,
    filed under it in the rail.
  - If no epics exist yet, only "Start something new" shows (no dead-end).
- Rail grouping change: nest **dm threads that have an epic** under that epic too
  (today only `group` threads nest; epic-less dms + main stay pinned at top).

**Files:** `orchestrator.ts` (1a), `ChatPage.tsx` (popover + grouping), maybe
`state.tsx`/`api.ts` if `createThread` needs a `workItemId` arg (it already accepts
`topic`; add optional `workItemId`).

## Item 2 — collapsible sections in the Git page
- Make each `EpicGitCard` section (Commits / Files changed / Tasks / Review comments)
  a collapsible `<Section>` with a chevron + count, default-collapsed when long
  (e.g. >8 rows). Diff toggle already exists. Persist open/closed in local state.
- **Files:** `GitPage.tsx` only.

## Item 3 — epic filters on Notifications + Git
- **Notifications:** add an "Epic ▾" `<select>` (All / per-epic / General) that filters
  `bundle.notifications` by resolving `n.workItemId` → epic. Reuse a shared
  `epicOfWorkItem(workItems, id)` helper.
- **Git:** add an "Epic ▾" filter to show a single epic's card (handy with many epics).
- **Files:** `NotificationsPage.tsx`, `GitPage.tsx`, small shared helper in `usage.ts`
  or a new `src/web/epics.ts`.

## Item 4 — epic filter on Activity
- Add an "Epic ▾" `<select>` next to the Agent/Type filters; filter events by
  resolving `e.workItemId` → epic. Also offer "No epic" for main-session events.
- **Files:** `ActivityPage.tsx` (+ shared helper).

## Item 5 — Dashboard: "In progress now" instead of Highlights

**What I think (recommendation):**
- **Enrich "Active now":** each active-agent row shows **what they're working on**
  (current in-progress item title + epic + progress) instead of the static role
  description — the most useful "who's doing what right now."
- **Replace "Highlights" with "In progress now":** list in-progress work items with
  assignee avatar, epic, and a progress bar (more actionable than milestone chatter).
  Milestones remain available on the Activity page, so nothing is lost.
- **Files:** `DashboardPage.tsx` only.

---

## Rollout / risk
- Do the **frontend-only** items (2,3,4,5 + 1b UI) first in one batch, verify, commit.
- Do **1a backend** last (isolated commit) so the single server restart is deliberate.
- Verify: `tsc`, `eslint`, `prettier`, `vitest`, `vite build`, targeted Playwright.

## Open questions for you
1. **Item 1b:** OK to keep conversation-first (no forced epic pre-creation)? *(Rec: yes.)*
2. **Item 5:** Replace Highlights with "In progress now" (milestones stay on Activity),
   or keep Highlights AND add the in-progress view? *(Rec: replace.)*
3. Any preference on **default-collapsed** Git sections threshold? *(Rec: collapse
   Commits/Review when >8 rows; keep Files/Tasks open.)*
