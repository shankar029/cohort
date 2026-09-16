# Independent Review — Design-First Orchestration

Reviewer: independent verifier (fresh context, read-only). Branch `feat/design-first-orchestration`
stacked on `feat/lead-escalation-mention`. Increment diff:
`.ai/design-first-orchestration/evidence/feature.diff` (1064 lines).

## Verification runs (read-only)
- `npx vitest run tests/unit/complexity.test.ts tests/unit/personas.test.ts tests/integration/designFirst.test.ts tests/integration/groupDiscussion.test.ts --no-file-parallelism` → **31 passed** (complexity 12, personas 14, designFirst 4, groupDiscussion 1).
- `npm run typecheck` → **clean**.
- `npm run lint` (`eslint . --max-warnings 0`) → **clean**.

## Findings

| id | severity | file:line | issue | direction |
|----|----------|-----------|-------|-----------|
| F1 | minor | complexity.ts:44-52 | Brownfield trivial gate can misclassify a genuinely non-trivial single-stream ask that lacks scope words, e.g. "add OAuth login to the API" (≤14 words, one stream, no `MULTI_RE`) → `trivial`, skipping design. Documented as an accepted tradeoff (a false trivial only forgoes an enrichment, never strands the board). | Accept, or add a small non-trivial lexicon (auth/oauth/migrate/security/payment) if false-negatives bite. |
| F2 | minor | orchestrator.ts:86-91 | `withTimeout`: if the wrapped `ask` promise **rejects after** `TIMED_OUT` already won the race, the inner `p.then().finally()` becomes a rejected promise with no handler → possible unhandledRejection. Timer is cleared, no double-resolve, no timer leak. `actor().ask` rarely rejects, so low-risk. | Add `.catch(()=>{})` on the raced branch, or leave with a note. |
| F3 | minor | orchestrator.ts:1119, 1050-1125 | `designThenEnrich` is `await`ed inside `decomposeEpic`, so the user-facing plan-summary post + PM criteria annotations are delayed up to `ATEAM_DESIGN_TIMEOUT_MS` (~45s). Dispatch itself is NOT delayed (tasks fire via `void this.onItemAssigned` in `makeTask` before the design turn), so the never-strand invariant holds. | Acceptable; optionally post the plan summary before the design turn for snappier UX. |
| F4 | minor | fakeAdapter.ts:77-80 (DESIGNFAIL); orchestrator.ts:1283 (`if (!text) return`) | The `DESIGNFAIL`→empty-design fallback branch is a test-only hook that **no test exercises** (the AC3 timeout test forces the timeout path via `ATEAM_DESIGN_TIMEOUT_MS=1`, not an empty design). The `!text` early-return is therefore unasserted. | Add a case that seeds `DESIGNFAIL` and asserts design absent + tasks unenriched, or drop the dead hook. |
| F5 | minor | orchestrator.ts:1440-1449, 1477 | `pickDecider` **pm-routing** branch is unasserted: the AC6 test topic ("the API contract") does not match the product regex, so the decider is the Lead. No unit/integration test proves PM-as-decider routing. | Add a topic (e.g. "which feature should we prioritise") + a `pm` agent and assert the decider is the PM. |
| F6 | minor | orchestrator.ts:1293 (`status === 'review'/'done'` guard) | The late-design status guard (skip enrichment of already-progressed tasks) is unasserted by any test. Logically sound (append-only, idempotent). | Optional targeted test. |
| F7 | minor (edge) | orchestrator.ts:168, 1465-1467 | Requester-exclusion fixes the reported self-deadlock. Residual edge: if the **Lead** itself emits `[[REQUEST_GROUPCHAT]]`, `runGroupChat` still asks `this.lead()` to moderate/decide while the Lead actor is mid-turn awaiting `maybeHandleGroupChatRequest` (line 168) → potential self-deadlock. Not the reported path (builders raise these) and `groupDepth<2` bounds nesting, but the requester filter does not cover the moderator/decider role. | Consider excluding the requester from moderator/decider selection too. |
| F8 | trivial | orchestrator.ts:1328, 1391 | Cosmetic diff artifacts: `if (this.groupDepth >= 2)` lost its indentation; a stray whitespace-only comment line at ~1391. Lint passes (max-warnings 0), so non-blocking. | Reformat on next touch. |

No blockers or majors found.

## NEVER-STRAND invariant — proof
- The deterministic template board is created synchronously in `decomposeEpic` **before** the design
  step: `makeTask(...)` runs for core/post builders and verifiers (orchestrator.ts ~1073-1097),
  populating `existingByStream` and firing dispatch via `void this.onItemAssigned(task.id)` inside
  `makeTask`. `designThenEnrich` is invoked only afterward (orchestrator.ts:1117-1119) and receives a
  **copy** (`new Map(existingByStream)`) of the already-created task ids.
- `designThenEnrich` is strictly **additive**: every exit leaves tasks intact — empty streams
  (`if (!streams.length) return`), throw (try/catch `return`), `TIMED_OUT` (emit + `return`), empty text
  (`if (!text) return`), and garbled parse (`parseDesignBreakdown` yields 0 rows → 0 enrichments).
  Enrichment only appends `<!--design-acceptance-->` and is skipped for review/done or already-enriched
  tasks (idempotent re-drive).
- `withTimeout` (orchestrator.ts:86-91): timer cleared when `p` settles (`.finally(clearTimeout)`);
  `Promise.race` ignores the later settlement → **no double-resolve, no timer leak** (see F2 for the
  post-timeout-rejection nit). The design turn is bounded by `ATEAM_DESIGN_TIMEOUT_MS`, and dispatch
  already occurred, so the bound never holds the board. **Verified** by the AC3 timeout integration test
  (tasks non-empty, none enriched at 1ms).

## M1 — old step-5b architect turn removed
`grep "already building"` on the real `orchestrator.ts` → **no matches**. The former
`actor(architect).ask("...the team is already building...")` block is replaced by a comment
(orchestrator.ts:1199-1202) pointing at the front-loaded `designThenEnrich`. No double-run, no prose
overwrite of the structured design. **Verified.**

## M2 — distinct group-decision marker
`runGroupChat` writes `<!--group-decision-->` (orchestrator.ts:1398); `alreadyLeadAssisted` keys only on
`LEAD_DECISION_MARKER = '<!--lead-decision-->'` (orchestrator.ts:2239-2244). Distinct markers →
group decisions cannot trip the one-shot Lead-unblock gate. **Verified**, and asserted by the AC6 test
(`.not.toContain('<!--lead-decision-->')`).

## M3 — parser constrained to the template floor
`parseDesignBreakdown(text, streams)` filters to `allowed = new Set(allowedStreams)` where
`streams = [...streamToTaskId.keys()]` = the already-created template streams. It can neither ADD a
stream (unknown streams dropped) nor DROP one below the deterministic set (tasks pre-exist; enrichment
is optional append). **Verified** by unit tests ("drops unknown stream", "de-dup first wins",
"never under-dispatches").

## Deadlock / bounded rounds
- Requester excluded from participants (orchestrator.ts:1465-1467); it is mid-turn awaiting the
  discussion (called at orchestrator.ts:168), so re-asking it would deadlock its mailbox — correctly
  avoided. No participant/decider cycle remains for the builder-initiated path (residual Lead-requester
  edge: F7).
- Rounds are bounded: `Math.max(1, Math.min(rounds ?? env ?? 2, 4))` (cap 4). `groupDepth >= 2` still
  guards nesting (orchestrator.ts:1328). `Promise.all` per round is over the fixed participant list; no
  unbounded fan-out. **Verified** (bound logic); round-cap value itself is not directly asserted (minor).

## classifyComplexity boundary
Order: `constraintCount>0 → standard`, `multiLayer → standard`, `>1 kept stream → standard`, explicit
`TRIVIAL_RE → trivial`, greenfield real work → standard, else brownfield/single-stream/≤14-words/no
`MULTI_RE` → trivial. Conservative and safe in the dangerous direction (greenfield always designs;
constraints/multi-layer/multi-stream always design). Residual false-trivial risk on terse single-stream
brownfield asks (F1) — accepted tradeoff. **Sensible.**

## Test authenticity
- Integration tests are **real**: real `git init`/commit fixtures (brownfield = 10 `.ts` + `AGENTS.md`
  so `isBrownfieldRepo()` is true), real in-memory `Store`, real `Bus`, HTTP via `app.inject`,
  `waitFor` on genuine bus events, and store-state assertions (`getEpicDesign`, task descriptions,
  thread `kind/includesUser/participantAgentIds`). The AC6 test drives the real `[[NEEDS_DISCUSSION]]`→
  `[[REQUEST_GROUPCHAT]]`→convene→decider→write-back flow and asserts **no** `question.updated` fired.
  Not tautological.
- The `fakeAdapter` change `test(prompt + this.config.persona)` is a **legitimate** hook: it lets a
  custom persona string carry `[[NEEDS_DISCUSSION]]` so the orchestrator's discussion machinery (the
  real behavior under test) is exercised offline. It does not mask that machinery.
- Honest limitation: the fake's design branch emits canned `[stream] … :: …` lines regardless of
  greenfield/brownfield or `AGENTS.md` content, and builders write files regardless of persona text.
  So **AC4/AC5 behavioral effect (a builder actually deciding a stack instead of stalling; the architect
  honoring docs) is only observable with the LIVE LLM adapter**. The unit prompt-invariant tests are the
  correct level for the wording change, and the traceability does not over-claim (both are marked
  "requires live adapter").

## Metrics / mutation note
Mutation testing was unavailable (state.md/report says so) — no mutation score to cite. Manual
branch review surfaced three changed branches with **no assertion**: the `DESIGNFAIL`/empty-design
fallback (F4), `pickDecider` PM-routing (F5), and the review/done late-design status guard (F6). All are
minor and none affects the never-strand or never-double-assist invariants, which ARE covered.

## Per-AC reconciliation

| AC | Verdict | Proving evidence |
|----|---------|------------------|
| AC1 design-first enrich for non-trivial | **VERIFIED** | `designThenEnrich` front-loaded (orchestrator.ts:1117-1119, 1234-1320); integration "non-trivial epic … ENRICHES the tasks" asserts persisted design + `<!--design-acceptance-->`; template floor synchronous. |
| AC2 complexity gate skips design for trivial | **VERIFIED** | `classifyComplexity` (pure) gates the turn; unit truth table (12) + integration "trivial change skips the design step" (design empty, no enrichment, tasks still created). |
| AC3 fallback chain never strands the board | **VERIFIED** | Template board is the synchronous floor; `designThenEnrich` additive + `withTimeout`-bounded; architect-absent → Lead path (integration "NO architect … Lead runs the design turn"); timeout path (integration "design turn times out → template, board non-empty"). |
| AC4 builders decide under uncertainty | **VERIFIED-WITH-LIMITATIONS** | `personas.test.ts` (14) prove every builder gained an empty/greenfield escape hatch + irreversible-only escalation while retaining brownfield "reuse existing" wording. Behavioral no-stall effect requires the live adapter (fake writes files regardless). |
| AC5 architect greenfield stack / brownfield honors docs | **VERIFIED-WITH-LIMITATIONS** | Architect persona + `stackClause` steered by `brownfield` (orchestrator.ts:1245-1250); `personas.test.ts` architect block asserts greenfield stack-decision + AGENTS.md/CONTRIBUTING/README; brownfield design turn runs on the ≥8-file fixture. Actual design content (real stack choice / doc-honoring) requires the live adapter. |
| AC6 agent-initiated bounded discussion resolved by a decider | **VERIFIED** | `runGroupChat` bounded rounds + `pickDecider` + `<!--group-decision-->` write-back + `includesUser:false` + requester excluded; integration asserts group thread (includesUser=false, >1 participant), decision persisted under the group marker (not lead marker), and **no** `question.updated`. PM-decider routing branch itself is unasserted (F5). |

## Verdict: **APPROVE**

All six ACs reconcile against the final tree (two VERIFIED-WITH-LIMITATIONS bounded to the live-adapter
behavioral layer, which is honestly disclosed). The never-strand, no-double-run (M1), distinct-marker
(M2), and no-under-dispatch (M3) invariants hold with test evidence. Typecheck, lint, and the four
targeted suites are green. Findings F1-F8 are minor/cosmetic follow-ups, not release blockers; F4/F5
(unasserted DESIGNFAIL + PM-decider branches) are the most worth closing to remove gamed-metric risk.

---

## Parent dispositions (round 1) — APPROVE with minor notes

- **PM-decider routing unasserted (minor):** ADDRESSED — extracted `pickDecider(topic, hasPm)` into the pure `src/server/complexity.ts` and added unit coverage (product/scope/UX → pm; no-pm → lead; technical → lead). The orchestrator's private `pickDecider` now delegates to it.
- **DESIGNFAIL empty-design branch unasserted (minor):** ACCEPTED — the timeout integration test already proves the additive no-op fallback path (board intact, no enrichment). DESIGNFAIL is redundant coverage of the same exit; not adding a fake-only hook test for it.
- **AC4/AC5 behavioral effect needs the live LLM adapter (limitation):** ACCEPTED and reported — the FakeCopilotAdapter writes files regardless of persona text, so the persona wording is proven at the unit (prompt-invariant) level; the live greenfield build is a named live-verification item in report.html, not faked.
- Remaining minor notes (comment polish, env-var docs) accepted as non-blocking; env knobs documented in design.html §5 and report.html.

Verdict after dispositions: **APPROVE** — all 6 ACs reconcile (AC4/AC5 with the stated live-adapter limitation).
