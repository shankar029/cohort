# Traceability — lead-escalation-mention

| AC | Requirement | Design | Test / check | Evidence | Verdict |
|----|-------------|--------|--------------|----------|---------|
| AC1 | On no-code-after-restart, the Lead makes a decision + re-drives BEFORE any user prompt | leadResolveBlocker + no-code path rewire (orchestrator.ts) | integration "the Team Lead makes a decision and re-drives BEFORE parking the run on the user" | leadEscalation.test.ts | VERIFIED |
| AC2 | If the Lead-assisted re-drive still yields no code, fall back to the user prompt exactly once (bounded) | alreadyLeadAssisted one-shot guard; restartedForItem interplay | integration (the fallback 'produced no code' question still surfaces after the Lead cycle); pre-existing delivery SEV-3 still green | leadEscalation.test.ts; delivery.test.ts | VERIFIED |
| AC3 | @mention wakes the Lead to take over pending no-code blockers, clearing the parked question | chat() mentionsAgent + leadTakeOverPending + resolveQuestionForItem | integration "@team-lead clears the parked no-code question and re-drives" | leadEscalation.test.ts | VERIFIED |
| AC3.1 | mentionsAgent matches valid mentions, rejects email@host/user@team-lead.io; escaped, ReDoS-safe | mention.ts (leading non-word boundary, escaped name, literal alternation) | unit "matches/rejects/ReDoS-safe" | mention.test.ts | VERIFIED |
| AC3.2 | Take-over scoped to no-code blockers only; never answers build/integration/epic-review with an invalid choice | noCodeQuestions map (design-review B1) | integration "does NOT touch unrelated escalations (B1)" | leadEscalation.test.ts | VERIFIED |
| AC4 | (item 3) Frontend no-code root cause documented + rescued by AC1 | research.md diagnosis (empty repo + no stack decision → info-gathering loop); Lead supplies stack/spec via leadResolveBlocker | research.md (live-DB evidence); AC1 test | research.md; leadEscalation.test.ts | VERIFIED |
| AC5 | Web: "@ Team Lead" affordance inserts the mention token | ChatPage.tsx AtSign button (data-testid mention-lead) | e2e "the @ Team Lead affordance inserts the mention token and sends it" | _mention.spec.ts | VERIFIED |
