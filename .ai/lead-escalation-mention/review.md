# Independent Review — lead-escalation-mention

Reviewer: independent reviewer + requirement verifier (fresh context, READ-ONLY)
Repo: cohort · Branch: `feat/lead-escalation-mention` (`58fe689`) vs `origin/main`
Scope: diff correctness/safety/test-quality + independent AC reconciliation against FINAL code+tests.

## What I ran (read-only)
- `npx vitest run tests/unit/mention.test.ts tests/integration/leadEscalation.test.ts` → **8 passed** (unit 6, integration 2; integration ~17s, real git repo + `[[NOOP]]` builder).
- `npm run typecheck` (`tsc --noEmit`) → **clean**.
- `npm run lint` → **FAILS: 66 errors** — all in `.ai/assets/artifact.js` (browser globals), a file **added by this branch's commit**. `npx eslint src/server/mention.ts src/server/orchestrator.ts src/web/pages/ChatPage.tsx` → **clean**.
- `git diff origin/main` inspection of all changed files; traced boundedness, B1 scoping, cross-restart, tick-safety, regex.
- E2E (`tests/e2e/_mention.spec.ts`) **not executed** (requires browser); verified statically (testids + affordance code present; `_`-prefix matches repo convention and Playwright default `testMatch`).

## Findings

| # | Issue | Severity | Location | Direction |
|---|-------|----------|----------|-----------|
| F1 | Branch commits `.ai/assets/artifact.{js,css}` (design.html render assets) that are **not** eslint-ignored → `npm run lint` now fails with 66 `no-undef` errors. Regression: main has neither file and lints clean. Breaks the lint gate on this branch. | **Major** | `.ai/assets/artifact.js`, `eslint.config.js:7` (ignores list) | Add `.ai/**` (or `**/assets/*.js`) to eslint `ignores`, or don't commit rendered design assets. Feature `src/**` lints clean; this is a repo-hygiene/CI regression, not a feature-logic defect. |
| F2 | Cross-restart DB fallback in `resolveQuestionForItem` is effectively dead in practice: `noCodeQuestions` is in-memory only, so after a process restart the map is empty and `leadTakeOverPending`/`resolveQuestionForItem` can never reach the `store.answerQuestion` branch for a pre-restart parked question. | Note | `orchestrator.ts:2145-2158, 281` | Defense-in-depth is fine; but the "answer across a process restart" guarantee (design M3) isn't reachable via @mention after restart because the map isn't persisted. Persist/derive `noCodeQuestions` from the `<!--lead-decision-->`+pending-question join if cross-restart take-over is required. |
| F3 | B1 scoping test uses an unrelated question with `agentId:null` and no in-memory resolver. It proves the map-scoped sweep, but does **not** exercise the original B1 hazard (an unrelated pending question owned by the **same** agent). | Note | `tests/integration/leadEscalation.test.ts:88-110` | Add an unrelated pending question with the same `assigneeAgentId`/agent to make the scoping proof airtight against the old agentId-match design. |
| F4 | Repeated @mentions are bounded but wasteful (design M1): each mention re-drives, and the parked `.then`'s `restartedForItem.delete` grants one extra restart cycle before re-parking a new user prompt. No infinite loop. | Note | `orchestrator.ts:2123-2138, 2826-2830` | Acceptable; optionally short-circuit take-over when `alreadyLeadAssisted` and just re-drive without re-parking. |
| F5 | Several changed branches are unasserted (mutation skipped, UI project): the no-code question **"Skip"** branch, the **paused** take-over branch, and the `stripMention` intent-suppression at the integration layer. | Note | `orchestrator.ts:2818-2833, 2126-2137` | Not blocking; unit tests cover `stripMention` directly. |

No blockers found for feature logic. No infinite Lead↔agent loop; no tick-crash path; regex is ReDoS-safe.

## Deep-dive verification

**Boundedness (one-shot Lead assist, human prompt exactly once).** Traced `orchestrator.ts:2772-2833`:
1) 1st no-code → `restartedForItem.add` + restart session + `return`.
2) still empty → `restartedForItem.has`=true → `alreadyLeadAssisted`=false → `leadResolveBlocker` (sets `leadAssisted` + writes `<!--lead-decision-->` marker) → re-queue + `return`.
3) still empty → `restartedForItem.has`=true, `alreadyLeadAssisted`=true (in-mem **and** persisted marker) → falls through to the user prompt **once**. Sequence attempts→restart→attempts→lead-resolve→attempts→user-prompt. Bounded. The autonomous board loop never re-enters `leadTakeOverPending` (only `chat()` @mention does), so no self-sustaining loop.

**B1 scoping (no-code ONLY).** Verified only the no-code site passes the 5th arg: of the 11 `raiseQuestion(...)` call sites, **only** `2812` passes `item.id` (`trackNoCodeItemId`); the build/constraint/QA/integration (`2916/2993/3090/3252/3323`) and epic-review budget/constraint/build/probe/criteria (`3717/4033/4205/4352/4481`) sites pass 3 args → never registered in `noCodeQuestions` (`5045`). `leadTakeOverPending` iterates **only** `noCodeQuestions` (`2165-2185`). `resolveQuestionForItem` is always called with the literal `'Retry'`, which is a valid choice of the no-code question `['Retry','Skip this task']` — never an out-of-choices answer. Confirmed against the epic budget question `['Keep working','Merge anyway']`: unreachable by the sweep.

**Cross-restart correctness.** `alreadyLeadAssisted` reads the persisted `<!--lead-decision-->` marker (`2047-2049`), so a post-restart re-drive won't repeat the Lead decision (better than design M2 feared). `resolveQuestionForItem` marks the DB row answered when the in-memory resolver is gone (`2148-2158`) — but see F2 (not reachable via @mention after a restart because the map isn't persisted). Normal in-memory answer persists via the `pending` resolver closure (`raiseQuestion` 5055-5062: `store.answerQuestion` + `question.updated`).

**Never crash the manager tick.** `actor(lead).ask` in `leadResolveBlocker` is `try/caught` with a generic-directive fallback (`2081-2087`). `runWorkItem` wraps `runWorkItemInner` in `try/finally` (`2528-2537`) and every tick call site voids with `.catch(()=>undefined)` (`1812`); `chat()`→`leadTakeOverPending` is fire-and-forget from the route (`app.ts:546-549`). Paused handled: `leadResolveBlocker` queues to `todo` + posts a resume note without `pokeLead` (`2127-2138`); `runWorkItem` returns early when paused.

**mention.ts regex.** `new RegExp('(^|[^\\w@])@(?:'+alt+')(?!\\w)','i')`. `displayName` is `escapeRegExp`-escaped before the flexible separator rewrite; aliases use only bounded `[-\s]?` — no nested quantifiers → **ReDoS-safe** (unit "returns fast" on 100k input). Leading `[^\w@]` rejects `user@team-lead.io`/`foo@lead`/`a@@lead` (char before `@` is a word char or `@`); trailing `(?!\w)` rejects `@leadership` but allows sentence-ending `@team-lead.`. Matches unit positives/negatives.

**Test authenticity.** Integration tests are **real**: real `git init`+commit fixture repo, real project/agent/chat via `app.inject`, real `[[NOOP]]` builder that describes-but-writes-nothing, real bus `waitFor` on `question.updated` and real `store.listWorkItems/listQuestions` assertions. AC1 proves the Lead decision precedes the human prompt via the persisted marker + posted unblock message; AC3/B1 proves the no-code question flips to `answered` while a distinct `['Keep working','Merge anyway']` question stays `pending`. Not tautological, though B1 could be stronger (F3).

## Per-AC reconciliation

| AC | Verdict | Proving evidence |
|----|---------|------------------|
| AC1 — Lead decides + re-drives BEFORE the user prompt | **VERIFIED** | `orchestrator.ts:2791-2793` inserts `leadResolveBlocker` before `setStatus('needs_input')`/`raiseQuestion`; integration "makes a decision and re-drives BEFORE parking" asserts marker + unblock message precede the pending prompt. |
| AC2 — bounded fallback to user prompt exactly once | **VERIFIED** | Boundedness trace (`2772-2833`); same test still observes the `produced no code` pending question as the guaranteed backstop; `restartedForItem`×`alreadyLeadAssisted` interplay yields a single user prompt. |
| AC3 — @mention take-over clears the parked no-code question | **VERIFIED** | `chat()` 628-679 → `leadTakeOverPending`; integration asserts the no-code question transitions to `answered` after `@team-lead …`. |
| AC3.1 — mentionsAgent matches valid / rejects email-like, ReDoS-safe | **VERIFIED** | `mention.ts:38-46`; unit positives/negatives incl. `user@team-lead.io`, `foo@lead`, `a@@lead`, and the 100k ReDoS check. |
| AC3.2 — take-over scoped to no-code blockers ONLY | **VERIFIED** | Only site 2812 registers `noCodeQuestions`; sweep iterates that map only; `'Retry'` always in-choices; integration B1 shows the unrelated `['Keep working','Merge anyway']` question stays `pending`. (Strengthen per F3.) |
| AC4 — FE no-code root cause documented + rescued | **VERIFIED-WITH-LIMITATIONS** | `research.md` documents the confirmed live-DB root cause (empty greenfield repo + no stack decision → self-questioning loop); the rescue mechanism (Lead makes the stack/spec decision) is code-verified and AC1-tested. Limitation: rescue is proven on a `[[NOOP]]` fake builder, not the literal live FE persona; diagnosis is evidence-backed but the specific FE catalog-prompt fix is analysis, not a code change. |
| AC5 — web "@ Team Lead" affordance | **VERIFIED-WITH-LIMITATIONS** | `ChatPage.tsx:553-566` AtSign button (`data-testid=mention-lead`) inserts `@Team Lead `; e2e `_mention.spec.ts` asserts token insertion + send. Limitation: e2e not executed here (browser); verified statically. |

## Metrics note
Mutation was skipped (project=`ui`, `mutation_score_pct` unavailable per `metrics.json`), so branch coverage rests on assertions. Changed backend branches that ARE asserted: Lead-decision-before-prompt (marker + message), no-code→answered transition, and cross-question scoping (unrelated stays pending). **Unasserted** changed branches (F5): the no-code "Skip" `.then` path, the paused take-over path, the `store.answerQuestion` cross-restart fallback (F2, likely unreachable), and integration-level intent suppression via `stripMention` (covered only by unit). `typecheck` clean; `lint` fails solely on committed design assets (F1), not on feature source.

## Overall: **REQUEST-CHANGES**

The feature logic is correct, bounded, tick-safe, and well-tested; all seven ACs reconcile (two with stated limitations). The single reason for REQUEST-CHANGES is **F1**: this branch's commit introduces `.ai/assets/artifact.{js,css}` that break `npm run lint` (66 errors) where `origin/main` is clean — a lint/CI-gate regression that must be resolved (eslint-ignore the assets or drop them from the commit) before merge. F2–F5 are non-blocking notes. Once F1 is addressed, this is an APPROVE.

---

## Parent dispositions (round 1)
- **F1 (major, blocker) — .ai/assets break `eslint .`:** FIXED — added `.ai` to eslint `ignores` (eslint.config.js). `npm run lint` clean.
- **F3 (note) — B1 test not airtight for same-agent question:** FIXED — the B1 test now also seeds an unrelated pending question owned by the SAME agent as the no-code blocker and asserts it stays `pending` after take-over.
- **F2 (note) — cross-restart @mention take-over:** ACCEPTED as a limitation. `noCodeQuestions` is in-memory by design (it is the B1 scoping guard); deriving it from question text after a restart would reintroduce the B1 hazard. This matches pre-existing behavior (the in-memory `pending` resolver is also lost on restart for the normal answer button). Documented in report §Assumptions.
- **F4/F5 (notes):** ACCEPTED — bounded/wasteful repeat-mention and a few unasserted branches (Skip path, paused take-over) left as follow-ups; core branches are asserted.

Verdict after fixes: **APPROVE** — F1 resolved, all 7 ACs reconcile (AC4/AC5 with the stated limitations).
