# State — lead-escalation-mention

Requirement (cohort): (1) blocked agents invoke the Team Lead instead of prompting the user; (2) @mention the Team Lead to wake it and address the issue; (3) diagnose/fix the Frontend "no code" bug.

Current phase: 4 — Implement (I1 of 2)
Gates: G1 ✅ | G2 ✅ (2b: REVISE→addressed) | G3 ✅ | G4 ⬜ | G5 ⬜ | G6 ⬜
Branch: feat/lead-escalation-mention (base main)
Next action: Implement I1 — mentionsAgent helper, leadResolveBlocker, no-code path rewire, unit + integration tests.
Blocked on: none

## Acceptance criteria (see traceability.md)
- [ ] AC1 On no-code-after-restart, the Team Lead makes a decision + re-drives BEFORE any user prompt
- [ ] AC2 If the Lead-assisted re-drive still yields no code, fall back to the user prompt exactly once (bounded)
- [ ] AC3 @mention (@lead / @team-lead / @<lead name>) wakes the Lead to take over pending no-code blockers, clearing the parked question
- [ ] AC3.1 mentionsAgent matches valid mentions, rejects email@host / user@team-lead.io; escaped, no ReDoS
- [ ] AC3.2 Take-over is scoped to no-code blockers only — never answers build/integration/epic-review questions with an invalid choice
- [ ] AC4 (item 3) Frontend "no code" root cause documented + rescued by AC1 (Lead supplies stack/spec); diagnosis in research.md
- [ ] AC5 Web: "@ Team Lead" affordance inserts the mention token into the composer

## Log
- 2026-09-15 P1 Understand: diagnosed FE no-code from live DB (empty repo + no stack decision → info-gathering loop). research.md.
- 2026-09-15 P2 Design + Gate 2b: design-review REVISE (B1 blocker + 3 majors) → revised design.html.
- 2026-09-15 P3 Plan: increments I1/I2 in design §7. Branch created.
