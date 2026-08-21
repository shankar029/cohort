# Dashboard + UX + Resume Plan

**Goal:** Add a project Dashboard, fix markdown rendering in chat, board-item detail view, startup work-resume, and agent editing (prompt/model/skills).
**Status:** in progress

## Steps

- [x] 1. Markdown rendering — react-markdown+remark-gfm+typography; `Markdown` component; used in Chat, plans, work-item detail.
- [x] 2. Dashboard page — KPIs, task distribution, epic progress, team roster, recent activity. Default landing.
- [x] 3. Board item detail modal — click title → full details + inline status/priority/assignee edits, deps, child tasks, PR.
- [x] 4. Startup resume — `resumeWork()` clears stale statuses, rebuilds worktrees, promotes deps, requeues work.
- [x] 5. Agent editing — Edit form (name/description/prompt/model/skills) in AgentDetailPage.

## Phase 2 (new requirements)

- [x] 6. Work-item progress (0-100%) — schema field, `update_progress` app tool + `[[PROGRESS:n]]` marker, lifecycle (10% start → 100% done), epic roll-up, shown on cards + detail slider.
- [x] 7. Dashboard shows progress (epic roll-ups, task distribution).
- [x] 8. Notifications — entity + store + WS + nav bell w/ unread badge + page; click routes to chat/board/pulls; epic/plan/task/pr/review/merge/question emit notifications.

## Verification

- Gate: tsc + eslint + prettier + vitest + playwright build. Add tests for resume + markdown.

---

# Phase 3 — Lead ownership, Architect, review workflow

**Goal:** Team Lead truly owns the project (assigns work + proactively manages); add an Architect who designs epics and reviews PRs with per-comment fix assignment; Lead is sole approver/merger.
**Status:** in progress

## Decisions (confirmed)

- Epic filter → **dropdown** (chips don't scale with many epics).
- **Team Lead assigns** all work (no agent self-pickup). Lead runs a proactive manager loop.
- Epic owner locked to Lead. Architect designs epics + reviews PRs. Lead is sole approver/merger after all comments resolved.

## Steps

### A. Small wins

- [x] A1. Lock epic owner to Lead in board detail modal (no assignee select for epics; show "Owned by Team Lead").
- [x] A2. Board epic filter → dropdown `select` (keep `data-testid="epic-filter"`); remove chip component; persist last selection per project (localStorage).

### B. Architect agent

- [x] B1. Add `architect` to catalog (design-focused prompt + skills, emoji/color).
- [x] B2. `planEpic`: insert Architect design step after PM → architect writes the epic's living plan (design: approach, components, risks, streams) and posts a design summary to chat. Lead then assigns the decomposed tasks (task creation stays deterministic per available specialist so tests stay green; attributed to the architect's design). Fake-adapter design marker as needed.

### C. Team Lead proactive manager loop

- [x] C1. `LeadManager` in orchestrator: event-driven (debounced on board/agent events) + periodic heartbeat via SchedulerService.
- [x] C2. Deterministic assignment: assign unassigned `todo` items with satisfied deps to best-matching agent (stream/skills); requeue via `onItemAssigned`. This is how review fix-tasks and user-added cards get picked up — the **Lead** assigns, agents never self-pick.
- [x] C3. Monitoring/guidance: detect blocked/stalled/needs_input agents; Lead posts concise guidance (throttled; deterministic/no-op in fake mode unless triggered). Call a group discussion on cross-stream conflict or repeated review failures.
- [x] C4. Ownership heartbeat: while epics are active the Lead posts a throttled, deduped status update to main chat (progress per epic, who's on what, what's next). Tunable via ATEAM_STATUS_HEARTBEAT_MS.

### D. PR review with comments (Architect reviews)

- [x] D1. `PrComment` entity + `pr_comments` table + store CRUD + `pr_comment.updated` WS event; bundle carries comments.
- [x] D2. Architect is the reviewer (fallback reviewer→qa→security). Reviewer app tool `add_review_comment(body, targetStream)`; fake marker `[[REVIEW_COMMENT: stream | body]]`.
- [x] D3. Each comment → a fix task the **Lead assigns** to the target agent; comment `status: open`. Comment resolves when its fix task reaches review/done.
- [x] D4. UI: comments listed on the PR page with status + assignee; resolve indicator.

### E. Lead approves + merges

- [x] E1. Approval gated on **all comments resolved** + reviewer re-check; only the **Team Lead** approves+merges.
- [x] E2. On approve: close children + epic, PR → merged, progress 100, notify. Keep `MAX_REVIEW_ITER` deadlock guard → escalate to user if exceeded.

## Verification

- Gate per phase: tsc + eslint + prettier + vitest + playwright + build, all green.
- New tests: epic owner lock, dropdown filter, Lead-assigns unassigned item, architect design step, PR comment → fix task → resolve → Lead approval gating.

## Risks

- Touches tested epic→decompose→review→merge path + new entity/migration. Update `orchestration.test.ts`; add coverage.
- Comment-gated approval must not deadlock (cap → user escalation).
- Lead LLM manager loop cost/noise → throttle + deterministic in fake mode.
