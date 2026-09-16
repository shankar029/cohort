# Design Review — Design-first orchestration for Cohort

Independent DESIGN review (read-only). Graded against the bulletproof rubric: requirement coverage,
the central scar-tissue invariant, SOLID/right-sizing, grounding, parser contract, AC6 coherence,
testability, failure-mode completeness, and interaction with existing seams.

**Verdict: REVISE** — the design is well-grounded and appropriately sized, but one central-risk proof
gap (B1) and three cross-feature interaction gaps (M1–M3) must be closed before implementation.

---

## Grounding check (every named symbol verified against real code)

| Claim | Real? | Evidence |
|-------|-------|----------|
| `decomposeEpic` dispatch-first, annotate-after | ✅ | orchestrator.ts:899; step-4 template then step-5b annotations |
| Scar-tissue NOTE ("dispatch must never depend on a planning turn completing") | ✅ | orchestrator.ts:940–946 (verbatim) |
| `makeTask`/`existingByStream` idempotent reuse | ✅ | orchestrator.ts:978–1040 |
| Brownfield fan-out via `isBrownfieldRepo` + `pickBrownfieldBuilders` | ✅ | orchestrator.ts:883, 1049–1075; streamScope.ts |
| Step-5b architect design notes → `setEpicDesign` (prose, "already building", slice 0,6000) | ✅ | orchestrator.ts:1148–1174 |
| `runGroupChat` single round, Lead-only synth, `includesUser:true`, summary to main | ✅ | orchestrator.ts:1204–1265 |
| `maybeHandleGroupChatRequest` grabs `others.slice(0,3)` | ✅ | orchestrator.ts:1268–1305 |
| `pickDiscussants` prefers pm/ux/frontend/backend/qa, cap 4 | ✅ | orchestrator.ts:1305–1312 |
| `awaitEpicDesign` polls `getEpicDesign` every 500ms until bound | ✅ | orchestrator.ts:4130–4137 |
| `LEAD_DECISION_MARKER` / `alreadyLeadAssisted` / `leadResolveBlocker` write-back | ✅ | orchestrator.ts:2044–2117 |
| `raiseQuestion`, `resolveViaLead`/`ESCALATE:` human backstop | ✅ | orchestrator.ts:4998–5031 |
| `setEpicDesign`/`getEpicDesign`/`epic_designs` + `createThread` (`includesUser` default true) | ✅ | store.ts:807–824, 1117–1134 |
| Builder-side `awaitEpicDesign` gate (frontend/backend/data, architect present) | ✅ | orchestrator.ts:2617–2624 |
| `detectConstraints` (no-external-deps/in-memory/no-ui, pure) | ✅ | constraints.ts:36+ |

No invented API found. `classifyComplexity` and `planTasksFromDesign` are correctly flagged as NEW.
Grounding score: excellent.

---

## Findings

| id | severity | file/section | issue | recommended direction |
|----|----------|--------------|-------|-----------------------|
| **B1** | **blocker** | design.html §1,§4,§7 (Resume/restart row); orchestrator.ts:940–946, decomposeEpic | The design **weakens the invariant** from "dispatch never depends on a planning turn completing" to "…never past a bound." Today, tasks are materialized **synchronously with zero awaits** before any LLM turn, so a crash at any point leaves a full board. Design-first defers **all** `makeTask` calls until *after* the awaited design turn (or its timeout). This opens a **new strand-on-crash window** (up to `ATEAM_DESIGN_TIMEOUT_MS`, ~45s) during which the epic is `in_progress` with **zero child tasks**. The §7 "resume/restart mid-decompose" mitigation asserts `existingByStream` idempotency saves it — but that only helps if `decomposeEpic` is **re-invoked** for a childless `in_progress` epic. `resumeWork` re-drives *assigned tasks*; with zero tasks there is nothing to re-drive. This restart path is **not proven** in the design. | Prove (and test) that startup re-runs `decomposeEpic` for any `in_progress` epic with zero children; OR materialize deterministic placeholder tasks first and *refine titles/acceptance* from the design in place (keeps the synchronous board floor). State this explicitly as the invariant contract. |
| **M1** | major | design.html §2 (decomposeEpic row), §3 as-is→to-be | The design does **not specify removing/guarding the existing step-5b architect turn** (orchestrator.ts:1148–1174). If it remains, the architect runs **twice** and the post-dispatch `setEpicDesign` (prose, "already building", slice 0,6000) **overwrites** the pre-dispatch structured design — directly undermining AC1/AC5. Also unclear what happens to PM-criteria/`authorAcceptanceProbe`/lead-framing on the design-first success path. | Explicitly: on design-first success, **delete or short-circuit** the step-5b architect block (design already persisted); **retain** PM criteria + `authorAcceptanceProbe`. Document the step-5b disposition per branch. |
| **M2** | major | design.html §2 (runGroupChat row), §5 (decision write-back) | Decision write-back "reuses the existing `<!--lead-decision-->`-style marker." If it reuses the **exact** `LEAD_DECISION_MARKER`, it collides with `alreadyLeadAssisted()` (orchestrator.ts:2047–2049), which treats that marker as proof the Lead already ran its **one-shot** `leadResolveBlocker`. A group decision written with that marker would **suppress a later genuine unblock assist**. | Use a **distinct** marker (e.g. `<!--group-decision-->`) for AC6 write-back; keep `LEAD_DECISION_MARKER` reserved for `leadResolveBlocker`. |
| **M3** | major | design.html §5 (parser contract), §7 (malformed) | Parser is "tolerant; unknown streams dropped; empty → fallback," but **partial** output (some valid lines, some garbled) is under-specified. Dropping unknown streams can yield a breakdown **missing streams that `scopeStreams` deemed needed** → silent **under-dispatch** (not a strand, but a coverage regression). research.md flagged the "breakdown vs. scoper disagreement — which wins?" as UNKNOWN; the design does not resolve it. Also: multiple lines per stream collapse to one via `existingByStream`. | Define reconciliation: any needed stream (per `scopeStreams` keep-set) absent from the parsed breakdown **falls back to a template task for that stream**; empty/garbled overall → full template. Specify multi-line-per-stream handling. |
| **M4** | major | design.html §4 (`withTimeout`), §7 | `withTimeout(ATEAM_DESIGN_TIMEOUT_MS)` bounds the *wait* but a JS timeout wrapper does **not cancel** the underlying `actor(architect).ask`. On timeout→template fallback, the still-running architect turn can **later** call `setEpicDesign`, landing a **late design mid-build** — the exact "build now, re-validate against late design" churn the code at orchestrator.ts:2610–2620 was written to avoid. | Specify late-completion behavior: guard the persist (ignore design if dispatch already fell back), or mark the epic "template-dispatched" so a late design is dropped. |
| **N1** | minor | design.html §2 (catalog architect), AC6 `includesUser` | `runGroupChat` hardcodes `includesUser:true` (orchestrator.ts:1213) and posts a summary to main "so the user stays informed." This **surfaces** to the user but does **not block** (no `raiseQuestion`/await), so it is consistent with "don't block the user" — but the design should say so, and consider `includesUser:false` for agent-decider discussions to avoid implying a user turn is expected. | Document "surfaces ≠ blocks"; only escalate to `raiseQuestion` on decider `ESCALATE:`. Consider `includesUser:false` for pure agent-decider threads. |
| **N2** | minor | design.html §9 (testability) | Testing AC1/parser needs the Architect design turn to emit `[stream] title :: acceptance`. `FakeCopilotAdapter` answers checklist/PM turns but has **no marker** for a structured breakdown, nor for garbled/partial output. | Add a deterministic fake response (or marker, e.g. `[[DESIGN_BREAKDOWN: ...]]` and a garbled variant) so the parser's happy/partial/empty paths are all testable. |
| **N3** | minor | design.html §2 (classifyComplexity) | "Trivial = single-layer + no hard constraints + **short goal**." `shortGoal` is the first meaningful line (orchestrator.ts), not a length metric — "short goal" is ambiguous as a threshold. | Define the concrete measure (e.g. char/word bound on `shortGoal`, or drop it and rely on layer+constraint signals). |

---

## Per-AC coverage

| AC | Requirement | Mapped component(s) | Coverage |
|----|-------------|---------------------|----------|
| **AC1** | Design-first: Architect designs first, Lead splits into per-stream tasks | `planTasksFromDesign` + `decomposeEpic` rewire; `setEpicDesign` | **Covered**, but see B1 (strand window), M1 (double-run), M3 (parser), M4 (late design) |
| **AC2** | Complexity gate: trivial skips design | `classifyComplexity` (pure) → template branch | **Covered** (pure, no LLM in hot path); N3 threshold vague |
| **AC3** | Fallback chain never strands | template as terminal fallback; architect-absent→Lead; timeout/error→template | **Partially** — logically covered but the never-strand *guarantee* is exactly what B1 puts at risk on crash/restart |
| **AC4** | Builder personas decide under uncertainty | catalog.ts FE/backend/ux/data/devops persona edits (QA-style clause, conditioned on empty/ambiguous) | **Covered**; verified FE stall sentence (catalog.ts) and QA license both real; conditioning preserves brownfield reuse |
| **AC5** | Architect greenfield stack decision / brownfield honors docs | catalog.ts architect edit steered by `isBrownfieldRepo` | **Covered**; depends on M1 (don't overwrite with step-5b prose) |
| **AC6** | Agent-initiated bounded discussion, decider-resolved, written back | `runGroupChat`/`maybeHandleGroupChatRequest` edits: round cap, decider(lead\|pm), targeted pull, write-back | **Covered** structurally; see M2 (marker collision), N1 (includesUser semantics) |

Every AC maps to a named, real component. No AC is orphaned. Gaps are in the *hardness* of AC1/AC3
guarantees, not in coverage.

---

## Rubric notes

- **Central risk (scar-tissue):** The reconciliation (template floor + time-boxed pre-step) is a sound
  *idea*, but the design **redefines** the invariant and does not prove restart-safety for the new
  zero-child window. This is the single most important thing to fix (B1). Until proven, design-first
  is a *regression* of the very invariant it cites.
- **SOLID / right-sizing:** Good. `classifyComplexity` pure/deterministic; `planTasksFromDesign`
  single-responsibility and bounded; additive open/closed branch; AC6 backend-only for v1 (YAGNI on
  `createThreadSchema`/UI). No over-engineering; no new schema. Reuse of `epic_designs`/`threads` is apt.
- **Testability:** Drives through `createTestApp`/`app.inject`/`waitFor`/`FakeCopilotAdapter` — sound,
  but the fake lacks a structured-breakdown response (N2). The three fallback branches and a childless
  restart (B1) must have explicit integration tests.
- **Failure modes:** Mostly complete; missing the crash-during-design-window case (B1) and the
  late-completing design turn (M4).
- **awaitEpicDesign interaction (no double-run):** Confirmed benign — design-first persists via
  `setEpicDesign` *before* `makeTask`, so the builder-side `awaitEpicDesign` (orchestrator.ts:2617)
  short-circuits immediately. No conflict, provided M1 removes the redundant step-5b architect turn.

---

## Parent dispositions (round 1) — all accepted, design revised

- **B1 (blocker) — strand-on-crash window from deferring makeTask:** FIXED by removing the deferral entirely. The deterministic template board is now created **synchronously first** (today's exact never-strand behavior, unchanged). The structured design turn is **front-loaded** but only **enriches** the already-created tasks (appends per-stream acceptance via `updateWorkItem`); builders read it through the existing `awaitEpicDesign` wait. No new zero-child window; the scar-tissue invariant is preserved verbatim, not reinterpreted. §1, §2 (`designThenEnrich`), §4 diagram, §6 updated.
- **M1 — architect double-run / prose overwrite of structured design:** FIXED. The old step-5b architect turn (orchestrator.ts:1148–1174) is **removed**; the single front-loaded structured turn is the only architect design call. Stated in §2 `decomposeEpic` row and §3.
- **M2 — decision write-back marker collides with `alreadyLeadAssisted`:** FIXED. AC6 uses a **distinct** `<!--group-decision-->` marker, never the `<!--lead-decision-->` one. §1, §2 (runGroupChat row).
- **M3 — parser under-dispatch vs scopeStreams:** FIXED. The deterministic kept-stream set is the **floor**; enrichment is constrained to `breakdown ∩ keptStreams` and never removes/under-dispatches a kept stream. §1, §2, §4, §7.
- **M4 — withTimeout doesn't cancel the LLM turn (late design mid-build):** ACCEPTED as bounded. Enrichment only rewrites a task still in `todo`/`backlog`; a late design still persists for injection but does not rewrite an in-flight task. §7 failure modes.
- **AC6 `includesUser`:** changed to `includesUser:false` for agent-initiated discussions so they resolve within the team (AC6 intent — "instead of blocking on the user"); the user still sees the posted summary.

Verdict after revision: adjudicated REVISE → addressed. Proceeding (2-round bound; no REJECT, so no re-review required). Residual risk carried: M4 (late-design rewrite) is guarded but not cancellable — acceptable for v1.
