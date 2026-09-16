# State — design-first-orchestration

Requirement: Make Cohort's Team Lead run a DESIGN-FIRST flow — for non-trivial epics the Lead
creates a design task for the Architect first (greenfield: decide stack/conventions/frameworks;
brownfield: design within the repo honoring AGENTS.md/README/docs), then splits the design into
per-stream tasks and assigns; trivial/simple work skips design (Lead takes the call); a fallback
chain (architect-absent → Lead analyses+splits; design error/timeout → deterministic template)
NEVER strands the board; builder personas decide under uncertainty (fixes the greenfield FE
no-code stall); and agents can open bounded group discussions resolved by a decider instead of
blocking on the user.

Tier: NON-TRIVIAL (multi-part, design decisions, orchestrator behavior change) → full loop.
Base branch: feat/lead-escalation-mention (stacked on PR #2; reuses the escalation primitive).
Branch: feat/design-first-orchestration

Current phase: 6 — DONE (shipping)
Gates: G1 ✅ | G2 ✅ | G3 ✅ | G4 ✅×3 | G5 ✅ | G6 ✅
Next action: push + open PR (base feat/lead-escalation-mention).
Blocked on: none

## Acceptance criteria (see traceability.md)
- [ ] AC1 Design-first for non-trivial epics (Architect designs → Lead splits → assigns)
- [ ] AC2 Complexity gate: trivial/simple skip design; Lead splits directly
- [ ] AC3 Fallback chain never strands the board (architect-absent → Lead; error/timeout → template)
- [ ] AC4 Builder personas decide under uncertainty (greenfield FE builds without asking)
- [ ] AC5 Architect greenfield stack decision / brownfield honors docs (AGENTS.md/README)
- [ ] AC6 Agent-initiated bounded group discussion resolved by a decider (no user block)

## Increments (planned)
- [x] I1 — Personas decide under uncertainty (AC4) + Architect greenfield/brownfield wording (AC5). Committed fd83a0c.
- [x] I2 — Design-first decomposition + complexity gate + fallback chain (AC1, AC2, AC3, AC5 behavior). Committed eec3bb0.
- [x] I3 — Bounded group discussion: round cap + decider routing + decision write-back (AC6). Committed 5d4350f. Review disposition (pickDecider extract) committed after.

## Log
- 2026-09-15 P2 G2 ✅: design.html (all 6 ACs, 3 increments); independent design-review (fresh, same-model — gemini unavailable) → REVISE, 1 blocker (B1 strand window) + 4 majors. Revised: template board is a SYNCHRONOUS FLOOR + design ENRICHES (no deferral); step-5b architect removed (M1); distinct <!--group-decision--> marker (M2); enrich ∩ keptStreams floor (M3); includesUser:false for agent discussions. Dispositions appended to design-review.md.
- 2026-09-15 P3 G3 ✅: plan.html — I1 personas, I2 decompose rewire, I3 group discussion; build order + per-increment tests.
- 2026-09-15 P4 I1 G4 ✅ (fd83a0c): personas + architect wording; personas.test.ts (14). Honest: behavioral effect needs live adapter.
- 2026-09-15 P4 I2 G4 ✅ (eec3bb0): complexity.ts + designThenEnrich + decomposeEpic rewire; step-5b architect removed; complexity.test.ts + designFirst.test.ts (4). Fixed M4 guard (status→idempotency).
- 2026-09-15 P4 I3 G4 ✅ (5d4350f): runGroupChat bounded rounds + decider + group-decision write-back; fixed self-deadlock (requester excluded); groupDiscussion.test.ts. Fake reads NEEDS_DISCUSSION from persona.
- 2026-09-15 P5/P6 G5/G6 ✅: full suite 300 pass/1 skip; e2e 23 pass; probe pass. Independent review (fresh) → APPROVE, 6/6 ACs reconcile, no blockers; disposition: extracted+unit-tested pickDecider. report.html written. Ready to push + PR.
- 2026-09-15 P1 G1 ✅: research.md (354 lines, cited+typed) + traceability.md (6 ACs) via fresh-context researcher; 3/3 citations spot-checked (catalog.ts:67 FE stall; runGroupChat:1198/GROUPCHAT_RE:70; awaitEpicDesign:4130/isBrownfieldRepo:883). Key find: runGroupChat + awaitEpicDesign + isBrownfieldRepo already exist → R5/R1 are additive, not greenfield.

## Key facts (from research.md, cited)
- decomposeEpic (orchestrator.ts:899) is DISPATCH-FIRST, ANNOTATE-AFTER; scar-tissue NOTE (~925) forbids gating dispatch on a planning turn (once stranded an epic with zero tasks).
- Architect design turn today is step-5b AFTER dispatch (~1148), prompt says "team is already building"; persisted via setEpicDesign; read back + injected into builder prompts at ~2621-2626 with a bounded awaitEpicDesign (4130).
- isBrownfieldRepo (883) = tracked code files >= 8. shortGoal (5115). scopeStreams/pickBrownfieldBuilders (streamScope.ts) pure. No trivial/complexity classifier exists (must add).
- FE stall sentence: catalog.ts:67 "matches the project's existing framework ... never introduce a new pattern when one already exists". QA license: "if none exists, pick a sensible one and add it".
- runGroupChat (1198): single round, Lead-only synthesizer, chat-summary only, no round cap (only groupDepth<2), no decision write-back. maybeHandleGroupChatRequest (1268) grabs others.slice(0,3). GROUPCHAT_RE (70). requestGroupChat app tool (4680).
- Reuse for R5: LEAD_DECISION_MARKER (2044), leadResolveBlocker (2050), raiseQuestion/noCodeQuestions (5030), emitEvent (4926), mention.ts.
- No brownfield integration fixture exists (isBrownfieldRepo needs >=8 code files). Tests: createTestApp + app.inject + waitFor; FakeCopilotAdapter honors [[NOOP]] (no files) and [[REQUEST_GROUPCHAT]].
- Quality gate: typecheck (tsc --noEmit), lint (eslint . --max-warnings 0), test (vitest run; branches 70/others 80), e2e (playwright). Run orchestrator tests with --no-file-parallelism (Windows GC flake; not wired into config).

## Open unknowns (carried to design)
- Architect breakdown vs deterministic scoper conflict → recommend Architect-when-valid else deterministic.
- Design turn bound: reuse ATEAM_DESIGN_WAIT_MS (~45s) vs new ATEAM_DESIGN_TIMEOUT_MS.
- R5 decision surfaced in UI vs backend-only for v1 (recommend backend-only v1).
- R4 persona wording must be conditioned on empty/ambiguous so brownfield "reuse patterns" is preserved.
