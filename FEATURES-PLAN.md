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
