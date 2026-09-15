# Design Review — Lead-first escalation + @mention wake

Reviewer: independent design reviewer (read-only, pre-implementation)
Repo: cohort · Branch: `feat/lead-escalation-mention`
Design: `.ai/lead-escalation-mention/design.html` · Research: `.ai/lead-escalation-mention/research.md`

## Verdict: **REVISE**

The core Item-1/Item-3 mechanism (Lead-resolve before the human prompt in the no-code path) is
**feasible, bounded, and safe** against the real code. The Item-2 `@mention` take-over as specified
is **incorrectly scoped** and will corrupt/dismiss unrelated escalations, including epic-level ones
answered with an invalid choice. Fix the sweep scope and the design is approvable.

**Single most important fix:** Scope `leadTakeOverPending()` to *no-code* blockers only. Do **not**
map "any pending question whose agentId owns an awaitingInput item" — that also matches build-blocked,
integration-blocked, and epic review-budget escalations (see Blocker B1).

---

## Feasibility claims — verification results

| # | Claim | Result | Evidence |
|---|-------|--------|----------|
| 1 | Insert `leadResolveBlocker` before `setStatus('needs_input')` yields a BOUNDED loop | **HOLDS** | `orchestrator.ts:2610-2665`. First no-code → `restartedForItem.add` + restart + `return` (2610-2620). Re-drive still empty → `restartedForItem.has`=true (skip restart) → `leadAssisted.has`=false → `leadResolveBlocker` + `return`. `leadResolveBlocker` does **not** touch `restartedForItem`, so third pass: `restartedForItem.has`=true, `leadAssisted.has`=true → falls through to user prompt exactly once. Sequence: attempts→restart→attempts→lead-resolve→attempts→user prompt. Bounded, no double-escalation. |
| 2 | `moveItem(item,'todo')` + `pokeLead` re-queues; scheduler picks it up | **HOLDS (with a required detail)** | `runWorkItem` wraps `runWorkItemInner` in `try/finally { running.delete; pokeLead }` (2359-2377), so `running` is freed on `return`. `driveAssignedWork` (1771-1796) re-runs the item iff: status `todo` ✓, not in `running`/`awaitingInput` ✓, deps met ✓, and **`agent.status !== 'needs_input'/'blocked'`** and idle. The design's `setStatus(agent,'idle')` + `awaitingInput.delete` are **load-bearing** for this — both are listed in the design, so it works. Nothing else wedges it. |
| 3 | Pending Question maps back to the blocked item via `awaitingInput.has(w.id) && w.assigneeAgentId === q.agentId` | **MAPPING RESOLVES, BUT OVER-BROAD → see B1** | For no-code: `raiseQuestion(agent.id,…)` (2643) + `awaitingInput.add(item.id)` (2626) → `q.agentId` set, `awaitingInput` live while parked (deleted only in the answered `.then`). Mapping succeeds. **However** the same predicate also matches build-blocked (`2734/2744`), integration-blocked (`3141/3151`), acceptance/QA, and the **epic review-budget** escalation `raiseQuestion(lead.id,…)` + `awaitingInput.add(epic.id)` where the epic's `assigneeAgentId === lead.id` (`3536/3545`). |
| 4 | `answer(q.id,'Retry')` vs the parked `.then` re-queue is safe/idempotent | **BOUNDED, but design's idempotency claim is incomplete** | The no-code parked `.then` on `Retry` does `restartedForItem.delete; moveItem('todo'); pokeLead` (2655-2658). Combined with `leadResolveBlocker`'s own requeue, `moveItem` is idempotent, but the `.then` **also deletes `restartedForItem`**, granting one *extra* restart cycle on the next re-drive. Still bounded; the design's "double moveItem→todo is harmless" understates the interaction. Cross-restart: `answer()` returns `false` when the in-memory `pending` resolver is gone (`4892-4898`), leaving the DB row `status='pending'` forever (see M3). |
| 5 | `actor(lead).ask()` awaited inside the run/tick — re-entrancy / mailbox deadlock | **SAFE** | `leadResolveBlocker` runs inside `runWorkItemInner` for a **specialist** agent and awaits the **lead** actor — a different actor/mailbox; no self-deadlock. Matches the existing `reviveBlockedAgent` pattern (2003-2023). `chat()` is fire-and-forget from the route (`app.ts:545-550`, `void …chat().catch`), so a serialized lead-ask cannot hang the HTTP request. Wrap every `ask` in try/catch per the design's stated invariant. |
| 6 | Append to `work_items.description` + publish `workitem.updated` matches store/ws types | **HOLDS** | `store.updateWorkItem` accepts a `description` patch (`store.ts:638-660`); `workitem.updated` is the standard event shape published across the orchestrator (e.g. `moveItem` 4657-4666). No missing field. |
| 7 | Mention regex is safe (no ReDoS, escapes displayName, avoids `email@host`) | **NOT YET VERIFIABLE (pre-impl) — see M4** | Design says "escaped lead.displayName" and "word-bounded", which is the right intent. Must be enforced in code: `RegExp.escape` the displayName, and require a non-word char (or start) *before* `@` so `email@lead…`/`user@team-lead.io` don't match. Literal alternation has no ReDoS risk. |

---

## Blockers (must-fix before implementation)

| ID | Blocker | Why | Suggested fix |
|----|---------|-----|---------------|
| **B1** | `leadTakeOverPending()` is not scoped to no-code blockers. The predicate "pending question whose `agentId` owns an `awaitingInput` item" also matches **build-blocked, integration-blocked, acceptance/QA, and epic review-budget** escalations. | It would (a) append a bogus *"pick a tech stack + UI spec"* decision to unrelated items' descriptions, (b) call `answer(q,'Retry')` on questions whose valid choices are e.g. `['Keep working','Merge anyway']` (epic review budget, `3552`) or `['Retry','Skip this task']` — silently dismissing a user-facing question with an **invalid answer**, and (c) re-drive/mis-route epics assigned to the Lead. Concretely, the epic review-budget question has `q.agentId === lead.id` and `epic.assigneeAgentId === lead.id`, so it *matches* and gets answered `'Retry'`. | Track no-code-blocked items in a dedicated set (e.g. `noCodeBlocked: Set<string>` populated where `leadAssisted`/the user prompt is created) and only take over those. Or key take-over off the *question text/kind*, not the generic `awaitingInput`+agent match. Never answer a question with a value outside its `choices`. |

*(No infinite-loop or crash-the-tick blockers found — claims 1, 2, 5 hold.)*

## Majors (should-fix before merge)

| ID | Major | Evidence / Risk |
|----|-------|-----------------|
| **M1** | `leadResolveBlocker` re-runs unconditionally in the take-over path even when `leadAssisted.has(item.id)` is already true. | A parked no-code question only exists *after* the Lead already tried and failed (leadAssisted set). Re-mentioning re-does a full Lead decision + restart + eventual user prompt each time. Bounded per mention, but wasteful and appends duplicate decisions to `description`. Consider skipping the decision if already Lead-assisted, or make the appended spec dedup-aware. |
| **M2** | Persistence across restart: `leadAssisted` (and `restartedForItem`) are in-memory `Set`s (`299`). | After a process restart, a re-driven item that still produces no code will Lead-resolve *again* (leadAssisted lost) before reaching the user prompt — one extra unnecessary cycle. Acceptable if intentional, but call it out / consider deriving from a DB signal (e.g. a marker note or description tag). |
| **M3** | Cross-restart `answer(q.id,'Retry')` leaves the DB question `status='pending'`. | `answer()` returns `false` when the in-memory `pending` resolver is gone (`4892-4898`); `leadResolveBlocker` still re-queues, but the parked Question row is never marked answered → stays visible in the UI as an unresolved prompt while the item silently re-drives. Have take-over call `store.answerQuestion` directly (not only the in-memory resolver) when clearing. |

## Minors / notes

- **N1 — `listQuestions` returns all statuses.** `store.listQuestions` (`1427`) returns every question ordered by `created_at`, not just pending. `leadTakeOverPending` must filter `status === 'pending'`; the design says "pending" but the store call does not pre-filter.
- **N2 — chat intent double-firing.** `@lead what's your approach` still trips `discussIntent` (`approach|architect|…`) → a group chat *and* take-over; `@lead build …` trips `buildIntent` → `planEpic`. Design notes making the mention "build-neutral"; confirm the mention is stripped before intent classification, and decide whether a mention should suppress `discussIntent` too.
- **N3 — paused project.** `pokeLead()` is a no-op while `paused` (`1425`) and `runWorkItem` returns early when paused (`2360`). A take-over while paused will clear the question and move the item to `todo` but nothing re-drives it until resume. Not a loop, but the question disappears with no visible progress — surface this or gate take-over on `!paused`.
- **N4 — regex boundary (from claim 7).** Enforce `RegExp.escape(lead.displayName)` and a leading non-word boundary so `email@…`/`user@team-lead.tld` don't match. Extract to the pure `mentionsAgent(content, name)` helper as planned so it's unit-testable.
- **N5 — notification noise.** `leadResolveBlocker` emits a `system` event + posts a Lead message + annotates the item on every assist; a `@mention` sweep over several parked items will fan out several notifications at once. Consider a single consolidated take-over notice.
- **N6 — other `raiseQuestion` sites (research A4).** Correctly left out of scope; B1's fix must make sure they stay out of scope of the sweep too.

## What's already good (evidence)

- The no-code insertion point and bounding logic are correct against `orchestrator.ts:2610-2665`; `restartedForItem` interplay yields exactly one final user prompt.
- Re-queue path is compatible with `driveAssignedWork` gating (`1771-1796`) given the design's `setStatus('idle')` + `awaitingInput.delete`.
- Store/event surface is unchanged and type-compatible (`updateWorkItem` description patch, `workitem.updated`).
- Awaiting the lead actor from a specialist run is deadlock-free and matches `reviveBlockedAgent`; `chat()` is fire-and-forget so no request hang.
- Fake-adapter testability and the one-shot `leadAssisted` guard are sound design choices.
