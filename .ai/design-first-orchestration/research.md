# Research: Design-first orchestration for Cohort

Phase-1 ground-truth for the design-first / complexity-gate / fallback / decide-under-uncertainty /
agent-initiated-discussion change. READ-ONLY survey. Every claim is cited `path:line` (line numbers
are approximate — within ±5 of the printed offset — but the quoted text is verbatim) and typed:
**FACT** (read directly), **INFERENCE** (derived from read code), **HYPOTHESIS** (design guess),
**UNKNOWN** (could not confirm).

## Project profile
- **FACT** Fastify + React + TypeScript, better-sqlite3, single-user local web app that orchestrates
  GitHub Copilot SDK agents (Team Lead + specialists). `package.json` name `ateam`, type `module`,
  Node `^20.19 || >=22.12` (`package.json:1-13`).
- **FACT** Server core is one very large file: `src/server/orchestrator.ts` (~5150 lines). Persistence
  is a synchronous typed layer `src/server/db/store.ts`. Shared zod/api in `src/shared/api.ts`; HTTP in
  `src/server/app.ts`.
- **FACT** There is **no** `AGENTS.md`, `CLAUDE.md`, or `CONTRIBUTING.md` at the repo root (confirmed by
  the task author; not present in the working tree during this survey). Absence matters for R1
  brownfield ("honor any AGENTS.md/README/CONTRIBUTING/docs") — the design step must tolerate their
  absence and fall back to reading README/code conventions.

---

## Decomposition ordering + the scar-tissue invariant (grounds R1/R2/R3)

**FACT — current ordering is DISPATCH-FIRST, ANNOTATE-AFTER.** `decomposeEpic` (definition
`orchestrator.ts:~899`) runs, in order:
1. Create epic worktree/branch (`~905-940`, best-effort; falls back to repo dir).
2. **Scar-tissue NOTE** (`orchestrator.ts:~925-935`), verbatim:
   > "NOTE: we DISPATCH the stream tasks first (step 4 below), THEN consult PM / Architect / Lead as
   > best-effort annotations (step 5b). Those are LLM turns that can ask the user a question and block
   > indefinitely; gating delegation behind them once stranded an epic with zero assigned tasks while
   > the Lead tried to build everything itself. Dispatch must never depend on a planning turn completing."
3. **Step 4 — deterministic template decomposition** (`~940-1075`): `scopeStreams(content, …)`
   (`orchestrator.ts:~955`, defined `streamScope.ts`) drops read-only/UI streams; `makeTask(...)`
   (`~980-1030`) materializes one generic task per kept stream. Brownfield → converge on a single
   primary via `pickBrownfieldBuilders` (`~1040-1060`); greenfield → parallel per-stream fan-out
   (`~1062-1068`). Verifiers queued last with `dependsOn` (`~1070`). `goal = shortGoal(content)`
   (`~965`, `shortGoal` at `orchestrator.ts:~5115`).
4. Post plan summary to epic thread (`~1080-1098`).
5. **Step 5b — best-effort annotations AFTER work is running** (`orchestrator.ts:~1100-1185`), each in
   its own `try/catch` that swallows errors:
   - PM acceptance criteria: `actor(pm).ask(...)` → `parseCriteria` → `store.replaceCriteria`
     (`~1103-1146`).
   - **Architect design notes**: `actor(architect).ask("Design notes for epic … the team is already
     building…")` → `store.setEpicDesign({content: trimmed.slice(0,6000)})` (`~1148-1174`). The prompt
     literally says the team is **already** building — design is retro-fitted.
   - `authorAcceptanceProbe(epic, content, thread)` (`~1178`).
   - Lead framing turn: `actor(lead).ask("The tasks … are already created, assigned, and running …")`
     (`~1183-1195`).

**INFERENCE — the SEAM for R1/R2.** A design-first step inserts between the worktree setup
(`~940`) and the deterministic template (step 4, `~940`). The complexity gate (R2) and design task
(R1) must run *before* `makeTask`. But the scar-tissue invariant forbids gating dispatch on a planning
turn. **Reconciling design (R1) with "never strand the board":**
- **HYPOTHESIS** Keep the deterministic template (step 4) as the guaranteed fallback and make the
  design step *time-boxed* — reuse the existing `awaitEpicDesign(epicId, ATEAM_DESIGN_WAIT_MS ~45s)`
  bounded-wait primitive (see R1 §2) rather than an unbounded `.ask`. On success the Lead splits the
  design into concrete per-stream tasks; on timeout/error/architect-absent, fall through to today's
  `makeTask` template. Dispatch is still guaranteed within the bound.
- **FACT — invariants that must be preserved:** (a) decomposition is IDEMPOTENT (reuses
  `existingByStream` tasks, `~972-1010`) — R1's Lead-created tasks must go through the same
  `existingByStream` reuse path so a re-drive/resume never duplicates. (b) `scopeStreams` /
  `pickBrownfieldBuilders` are pure and never block. (c) `onEpicCreated` (`~1354`) and `setPaused`
  resume (`~1330`) both call `decomposeEpic`, and `resumeWork` (`~2270`) re-drives assigned tasks —
  any new state (design task, gate decision) must survive a process restart (persist, don't keep only
  in-memory) or the board can strand after a crash.

---

## R1 — Design-first flow (Architect designs, then Lead splits)

**FACT — Architect participation today.** Only the best-effort step 5b `actor(architect).ask(...)`
(`orchestrator.ts:~1149`) after dispatch. Result persisted via `store.setEpicDesign(...)`
(`orchestrator.ts:~1165`; store impl `db/store.ts` "epic design" section:
`setEpicDesign` upserts into `epic_designs(epic_id,project_id,content,updated_at)`, `getEpicDesign`,
`deleteEpicDesign`).

**FACT — design is READ BACK into builder prompts.** In `runWorkItemInner`
(`orchestrator.ts:~2607-2625`):
- Contract streams gate: `const contractStream = /^(frontend|backend|data)$/.test(item.stream)`; if the
  epic has an Architect and no design yet, `await this.awaitEpicDesign(item.parentId,
  Number(process.env.ATEAM_DESIGN_WAIT_MS ?? 45_000))` — a **bounded wait** so contract-consuming
  builders align on the same interfaces (`~2612-2620`).
- `const design = item.parentId ? this.deps.store.getEpicDesign(item.parentId) : ''` then injected as
  `designClause` = "# Epic technical design (follow it - honor these shared interfaces/contracts)…"
  into `basePrompt` (`~2621-2660`).

**FACT — Architect persona already expects design-first.** `catalog.ts` architect prompt
(`catalog.ts:~40-45`):
> "…produce a concise technical design BEFORE any code is written: the approach and key decisions (with
> trade-offs), the components/modules and their interfaces, data and control flow, risks and
> mitigations, and a **dependency-ordered breakdown of the work into small tasks tagged by stream**…
> Ground every decision in the existing codebase and conventions — read before you design, and prefer
> reusing patterns over inventing new ones. Keep it tight and actionable so the Team Lead can assign
> directly." (`tools: READONLY` — architect cannot write code.)
The persona already promises a stream-tagged breakdown; only the *ordering* (design → split) and the
*greenfield stack-decision* wording are missing.

**INFERENCE — SEAM.** R1 = (a) a new pre-dispatch design turn producing a *structured*
stream→task breakdown (today's design turn produces prose only), (b) a parser that turns that breakdown
into `makeTask` calls (reuse `makeTask` + `existingByStream`), (c) reuse `setEpicDesign`/`getEpicDesign`
unchanged for the injected design text. `awaitEpicDesign` already exists as the bounded-wait building
block for the "design lands before builders" guarantee.

---

## R2 — Complexity gate (trivial/simple skip design)

**FACT — existing reusable complexity signals (all pure, no LLM):**
- `scopeStreams(request, streams)` (`streamScope.ts`) — deterministic keep/drop of builder streams via
  `HEADLESS_RE` / `UI_RE`; conservative, never empties.
- `pickBrownfieldBuilders(request, coreBuilders)` (`streamScope.ts`) — `LAYER_SIGNALS` regexes decide
  single-owner vs multi-layer fan-out; returns `{primaries, multiLayer}`.
- `isBrownfieldRepo()` (`orchestrator.ts:~880-897`) — counts tracked code files (`code.length >= 8`)
  to classify greenfield vs brownfield (cached).
- `detectConstraints(texts)` (`constraints.ts`) — regex extraction of `no-external-deps` / `in-memory`
  / `no-ui` hard constraints.
- `shortGoal(content)` (`orchestrator.ts:~5115`) — first meaningful line of the request.

**ABSENCE-PROOF — no explicit triviality/complexity classifier exists.** Searched the codebase text for
`trivial`, `simple`, `complexity`, `isTrivial`, `classifyComplexity`: the only matches are prose in the
`scopeStreams`/`pickBrownfieldBuilders` doc-comments ("single-layer", "cross-layer") — none is a
trivial/non-trivial decision. **INFERENCE:** R2 must ADD a `classifyComplexity(content, streams)`
signal. It can reuse `pickBrownfieldBuilders.multiLayer` (multi-layer ⇒ non-trivial), the kept-stream
count from `scopeStreams`, `detectConstraints` (any hard constraint ⇒ non-trivial), and `isBrownfieldRepo`
as inputs, keeping it pure so it never blocks dispatch (honoring the scar-tissue invariant).

---

## R3 — Fallback chain (never strand the board)

**FACT — the "never strand" invariant is already load-bearing and enforced in several places:**
- Scar-tissue NOTE (`~925-935`, quoted above).
- `scopeStreams` safety net: "never strand an epic with zero builders … fall back to the implementing
  streams" (`streamScope.ts` `if (keep.length === 0)…`).
- `scopedSpecialists` fallback: "Never strands: falls back to all assignable specialists if scoping
  empties the set" (`orchestrator.ts:~1900-1915`).
- Task-clone failure falls back to the shared epic clone (`runWorkItemInner ~2560-2575`).

**INFERENCE — the three R3 branches map onto existing seams:**
1. *Architect absent → Lead does analysis + splits.* Today, when no architect is on the team the step-5b
   design turn is simply skipped (`const architect = specs.find(s => s.name==='architect'); if
   (architect){…}` `~1148`) and the deterministic template already ran. R3 formalizes this: gate on
   `specialists().some(s => s.name==='architect')` (same predicate already used at `~2615`), and when
   false run a Lead analysis turn *before* the split — but still time-boxed.
2. *Design errors/times out → deterministic template.* The existing `try/catch` swallow (`~1148-1174`)
   and `awaitEpicDesign` bound are the fallback mechanism; R3 wires them so a timeout resumes the
   existing `makeTask` template path.
3. *Board never stranded.* Guaranteed if the deterministic `makeTask` fan-out remains the terminal
   fallback and design/analysis are strictly additive + time-boxed. Existing tests already assert this
   shape (see Testing §).

---

## R4 — Builder personas decide under uncertainty (fixes the FE greenfield stall)

**FACT — the exact FE stall sentence.** `catalog.ts` frontend-engineer prompt (`catalog.ts:~68-73`),
verbatim:
> "You are a staff frontend engineer. Implement clean, accessible (keyboard + ARIA), responsive UI that
> **matches the project’s existing framework, components, and design tokens — never introduce a new
> pattern when one already exists.** …"

On an empty/greenfield repo there IS no existing framework, so "never introduce a new pattern when one
already exists" gives the FE no license to choose one → it narrates, writes nothing → hits the
empty-build gate. **INFERENCE:** this is the reported "Frontend no code" stall.

**FACT — QA already has the decide-under-uncertainty wording** (`catalog.ts:~90-95`), verbatim:
> "Choose an E2E framework by first detecting what the repository already uses (e.g. Playwright,
> Cypress, Selenium, an HTTP client for API E2E); **if none exists, pick a sensible one and add it.**"

**FACT — the other builder personas that need the same treatment** (all in `catalog.ts`):
- backend (`~78-84`): "Follow the project’s architecture, data-access patterns, and naming." (no
  empty-repo escape hatch)
- ux (`~52-58`): "reuse existing patterns and design tokens rather than inventing new ones."
- data (`~178-184`): schema/migration focus, no ambiguity clause.
- devops (`~104-108`): "using the project’s existing tooling." (no ambiguity clause)

**INFERENCE — SEAM.** R4 edits the frontend/backend/ux/data/devops persona strings in
`catalog.ts` to add QA-style wording: "detect conventions; if the repo is empty/ambiguous, pick the
mainstream default, state the assumption, and proceed — build first, ask only for irreversible/product
decisions." Note the coverage `include` in `vitest.config.ts` lists `catalog.ts`, so persona edits are
under the 80% coverage bar but are pure strings (no branch coverage risk). The empty-build gate that
punishes the stall lives at `runWorkItemInner ~2740-2830` (see R5) and is unchanged by R4.

---

## R5 — Agent-initiated bounded group discussions resolved by a decider

**FACT — an agent-initiated group-chat primitive ALREADY EXISTS (partially):**
- `runGroupChat(topic, participantIds, workItemId)` (`orchestrator.ts:~1200-1265`): creates a `group`
  thread via `store.createThread({kind:'group', participantAgentIds:[lead,…], includesUser:true})`,
  Lead opens, participants contribute **once in parallel** (`Promise.all`), Lead **synthesizes** into "a
  clear decision and next steps", posts a summary to the main thread, closes the thread. Guarded by
  `groupDepth >= 2` against runaway nesting.
- `maybeHandleGroupChatRequest(requester, reply, workItemId)` (`~1288-1305`): matches
  `GROUPCHAT_RE = /\[\[REQUEST_GROUPCHAT:\s*([^\]]+)\]\]/i` (`orchestrator.ts:~68`) in an agent's reply
  and convenes `[requester, ...others.slice(0,3)]`.
- App tool: `appToolsFor(agent).requestGroupChat({topic})` (`orchestrator.ts:~4685`) → same handler.
  So agents can already OPEN a discussion.
- `resolveDiscussionEpic` (`~1310-1325`) attaches an ad-hoc discussion to the right epic.
- `pickDiscussants` (`~1330-1338`) prefers pm/ux/frontend/backend/qa, capped at 4.

**FACT — what R5 must ADD (proved by reading `runGroupChat`):**
1. **Bounded multi-round loop.** Current `runGroupChat` is a *single* round (open → parallel contribute
   → synthesize). R5's "BOUNDED rounds" needs an explicit round counter/cap — none exists beyond the
   `groupDepth<2` nesting guard.
2. **Decider selection (Lead vs PM for product).** Today the Lead ALWAYS synthesizes (`~1246`). R5 needs
   "resolve via a decider (Lead, or PM for product)" — route the synthesis/decision turn to the PM for
   product questions.
3. **Targeted participant pull.** `maybeHandleGroupChatRequest` blindly grabs `others.slice(0,3)`
   (`~1291`); R5 wants "pull in the needed participants (PM/Lead/peer)" — a targeted selector.
4. **Write the decision back.** `runGroupChat` posts a chat summary and closes the thread but does NOT
   persist a structured decision onto the work item/epic. R5 needs decision persistence.

**FACT — reusable escalation/decision primitives to generalize (R5 "reuse existing thread
infra + decision marker"):**
- **Decision-marker persistence:** `LEAD_DECISION_MARKER = '<!--lead-decision-->'`
  (`orchestrator.ts:~2035`); `alreadyLeadAssisted(item)` checks in-memory set OR the marker embedded in
  the task description (`~2040-2045`) so a decision survives a restart. `leadResolveBlocker`
  (`~2050-2130`) writes `\n\n<!--lead-decision-->\nTeam Lead decision (unblock):\n${guidance}` into the
  item description via `updateWorkItem` — the exact "write the decision back" pattern R5 wants.
- **Lead-as-decider fallback:** `actor(lead).ask(prompt, main.id, item.id)` inside `leadResolveBlocker`
  (`~2075`) and `resolveViaLead` (`~4995-5030`, which decides directly or replies `ESCALATE: <q>` to
  defer to the human) — the "decide within the team, escalate to human only if necessary" contract.
- **Human backstop:** `raiseQuestion(agentId, question, choices, trackNoCodeItemId?)`
  (`orchestrator.ts:~5030-5090`) persists a `Question`, notifies, and registers no-code blockers in
  `noCodeQuestions` (Map itemId→questionId) so `leadTakeOverPending` (`~2165-2190`, driven by an
  `@team-lead` @mention via `mention.ts`) can sweep ONLY those. `emitEvent` (`~4926`) is the uniform
  event/bus emitter.
- The empty-build → `leadResolveBlocker` → `raiseQuestion` chain (`runWorkItemInner ~2740-2830`) is the
  living example R5 generalizes from a 1:1 Lead↔builder unblock into an N-party decider-resolved thread.

**FACT — thread infrastructure inventory (`db/store.ts`, "threads" section):**
`ensureMainThread(projectId)`, `createThread({projectId,kind,topic,workItemId?,participantAgentIds?,
includesUser?})`, `listThreads`, `getThread`, `closeThread`, `renameThread`, `deleteThread`. There is
**no** `ensureEpicThread` in the store — that helper lives in the orchestrator (called in
`decomposeEpic ~903` and referenced as `threadForWorkItem` in `runWorkItemInner ~2540`).
`Thread` type: `{kind, topic, status, workItemId, participantAgentIds, includesUser, …}` where
`kind: ThreadKind` (`'main' | 'epic' | 'group' | …`) — mapper `toThread` at `db/store.ts` ThreadRow
section.
- **api/shared:** `createThreadSchema = z.object({ topic: string.max(120).optional(), workItemId:
  string.optional() })` (`src/shared/api.ts:~82-86`) — only topic + workItemId; no `kind`, no
  participants, no "resolution" fields. `Thread` domain type exported from `@shared/index`.
- **HTTP routes (`src/server/app.ts`):** `GET /api/projects/:id/threads` (list), `GET
  /api/threads/:threadId/messages` (thread + messages), `POST /api/projects/:id/threads` →
  `orchestrators.get(id).createLeadThread(topic, workItemId)`. No route creates a *group* thread with
  participants, and none records a decision/resolution.

**INFERENCE — R5 SEAM.** Extend `runGroupChat` (or add a sibling) with: a round cap (env-tunable like
`ATEAM_DESIGN_WAIT_MS`), a `decider` param (lead|pm), a targeted participant selector, and decision
write-back reusing the `<!--decision-->`-marker/`updateWorkItem`/`emitEvent` pattern. Reuse
`store.createThread`/`closeThread`/`listThreadMessages` unchanged. `createThreadSchema` may need
`participants`/`kind` only if the UI must open agent discussions; the agent path already flows through
`requestGroupChat`/`maybeHandleGroupChatRequest` without an HTTP change.

---

## Testing seams (grounds all ACs)

- **FACT** `createTestApp()` (`tests/helpers/testApp.ts`) wires a real `Store` on an in-memory sqlite,
  a `Bus`, `OrchestratorManager`, and a `FakeCopilotAdapter`. Exposes `app` (Fastify, driven by
  `app.inject`), `store`, `messages`, and `waitFor(predicate, timeoutMs)` that resolves on a matching
  bus event. `rmDir` retries on Windows EPERM.
- **FACT** `FakeCopilotAdapter` (`src/server/agents/fakeAdapter.ts`) is deterministic and honors prompt
  markers: `[[NOOP]]` = "narrate but write no files" (empty build); `[[ASK]]`/`[[ASK_USER]]`,
  `[[WRITE]]`, `[[NEEDS_DISCUSSION]]` → `[[REQUEST_GROUPCHAT]]`, `[[POST/NOTE/PLAN]]`,
  `[[REVIEW: iteration=N]]`, `[[EMIT_FILE: path|content]]`. When a task is assigned and `[[NOOP]]` is
  absent it writes a real `deliverables/<agent>-<msg>.md` so the empty-build gate is exercised for real.
  It also answers the checklist-planning turn and the PM `one criterion per line` / acceptance-judge
  turns deterministically.
- **FACT** Pattern `tests/integration/delivery.test.ts`: adds specialists via
  `POST /api/projects/:id/agents`, chats via `POST /api/projects/:id/chat`, then `waitFor`s on
  `pull_request.updated` merged / `workitem.updated` epic done, and asserts real `deliverables/` files
  landed. The empty-build test uses a `[[NOOP]]` backend and asserts a `question.updated` "produced no
  code" surfaces and the task never reaches review/done.
- **FACT** Pattern `tests/integration/leadEscalation.test.ts`: `addNoopBuilder` seeds a `[[NOOP]]`
  backend; asserts (AC-style) the blocked task carries the `lead-decision` marker + "Team Lead decision
  (unblock)" text BEFORE the human "produced no code" question, and that an `@team-lead` @mention
  resolves only the no-code question, leaving unrelated escalations pending (`noCodeQuestions` scoping).
- **FACT — greenfield vs brownfield fixture.** `delivery.test.ts` uses a bare `mkdtemp` repo (NOT
  git-init'd) → greenfield; `leadEscalation.test.ts` does `git init` + a single `README.md` commit →
  still greenfield (`isBrownfieldRepo` needs `>= 8` code files). **ABSENCE-PROOF:** no existing
  integration test seeds ≥8 source files, so **there is no brownfield fixture today** — a new AC for
  brownfield design/decide-under-uncertainty must create one (commit 8+ `.ts` files, optionally an
  `AGENTS.md`, before chatting).

## Quality-gate commands (`package.json` scripts)
- `typecheck`: `tsc -p tsconfig.json --noEmit`
- `lint`: `eslint . --max-warnings 0`
- `test`: `vitest run` (coverage thresholds in `vitest.config.ts`: lines/functions/statements 80,
  branches 70, `include` covers orchestrator/store/catalog/context/git/shared).
- `e2e`: `playwright test` (`e2e:install` for chromium).
- **UNKNOWN / GAP — the `--no-file-parallelism` flake.** The task notes a known Windows worktree-GC
  parallel-load flake requiring `vitest --no-file-parallelism`. **ABSENCE-PROOF:** `vitest.config.ts`
  does NOT set `poolOptions`/`fileParallelism:false`, and `package.json`'s `test` script is plain
  `vitest run` with no flag. So the mitigation is NOT wired into the default command — new orchestrator
  tests should be run/CI-invoked with `vitest run --no-file-parallelism` (or the flag added to config),
  else they may flake on Windows.

---

## Blast radius — files/functions that will change
- `src/server/orchestrator.ts`
  - `decomposeEpic` (`~899`): insert complexity gate + design-first branch before `makeTask`; keep
    template as time-boxed fallback (R1/R2/R3).
  - `makeTask` / `existingByStream` (`~972-1030`): consume the Architect/Lead per-stream breakdown
    idempotently (R1).
  - step-5b architect block (`~1148-1174`): move/duplicate design generation to a pre-dispatch,
    structured, time-boxed turn (R1).
  - `runGroupChat` / `maybeHandleGroupChatRequest` / `pickDiscussants` (`~1200-1338`): bounded rounds +
    decider + targeted participants + decision write-back (R5).
  - reuse (no change expected): `awaitEpicDesign` (`~2612`), `getEpicDesign` injection (`~2621`),
    `leadResolveBlocker`/`LEAD_DECISION_MARKER` (`~2035-2130`), `raiseQuestion`/`noCodeQuestions`
    (`~5030`), `scopedSpecialists` (`~1900`).
  - possibly new: `classifyComplexity(...)`, `leadAnalyzeAndSplit(...)` (R2/R3).
- `src/server/streamScope.ts`: possibly expose `multiLayer`/kept-count to the complexity classifier
  (R2).
- `src/server/agents/catalog.ts`: frontend/backend/ux/data/devops persona strings (R4); optionally
  architect prompt to add greenfield stack-decision + honor-AGENTS.md wording (R1).
- `src/server/db/store.ts`: only if R5 needs a structured decision field or R1 needs a "design status";
  otherwise reuse `epic_designs` + thread tables unchanged.
- `src/shared/api.ts` + `src/server/app.ts`: only if the UI must open agent discussions or read a
  decision (likely optional for a backend-only change).
- `tests/integration/*.test.ts` (+ a new brownfield fixture helper) and `tests/helpers/*`: new ACs.

## What does NOT exist yet (with absence-proofs)
- **No complexity/triviality classifier** — search for `trivial|simple|complexity|classifyComplexity`
  yields only doc-comment prose in `streamScope.ts`; no decision function. (R2 must add.)
- **No pre-dispatch design step** — the only Architect turn is step-5b *after* dispatch
  (`orchestrator.ts:~1148`, prompt says "the team is already building"). (R1 must add ordering.)
- **No greenfield stack-decision license for builders** — FE/backend/ux/data personas anchor on
  "existing framework/patterns" with no empty-repo escape hatch; only QA has "if none exists, pick a
  sensible one and add it" (`catalog.ts`). (R4 must add.)
- **No bounded-round / decider-routed / decision-persisting group discussion** — `runGroupChat` is a
  single round, Lead-only synthesizer, chat-summary-only, no round cap beyond `groupDepth<2`, no
  work-item write-back. (R5 must add; can reuse thread infra + `<!--decision-->` marker pattern.)
- **No brownfield integration fixture** — no test seeds ≥8 source files / an `AGENTS.md`. (New AC must
  add.)
- **No `AGENTS.md`/`CONTRIBUTING.md`/`CLAUDE.md`** at repo root. (Design step must tolerate absence and
  fall back to README/code conventions.)
- **`--no-file-parallelism` not wired** into `vitest.config.ts` or the `test` script. (Flake mitigation
  gap.)

## Gaps / open unknowns that could change the design
- **UNKNOWN** Whether the design-first split should replace or wrap `scopeStreams`/`pickBrownfieldBuilders`.
  If the Architect's breakdown and the deterministic scoper disagree, which wins? (Recommend: Architect
  breakdown when present + valid, else deterministic — but this needs a decision.)
- **UNKNOWN** Exact bound for the design turn. Reusing `ATEAM_DESIGN_WAIT_MS` (~45s) couples design
  generation to the existing builder wait; a separate `ATEAM_DESIGN_TIMEOUT_MS` may be cleaner.
- **UNKNOWN** How R5's decision write-back should be surfaced in the UI (no thread `kind`/participants
  in `createThreadSchema`); may be backend-only for v1.
- **UNKNOWN** Whether persona edits (R4) risk regressing the brownfield "reuse existing patterns"
  behavior that other live-run scars depend on — the new wording must be conditioned on
  empty/ambiguous, not blanket.
