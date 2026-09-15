# project-create-import
Requirement: (1) Support for creating a new project (2) Support for importing a GitHub project by URL
Tier: standard
Branch: feat/project-create-import
Design: design.html · Plan: plan.html · Architecture: n/a
Traceability: traceability.md

Current phase: 3 — Plan
Gates: G1 ✅ | G2 ✅ (2b APPROVE after revision; 2 taken as-proposed, unattended one-shot) | G3 ⬜ | G4 ⬜ | G5 ⬜ | G6 ⬜
Next action: Write plan.html (build-order increments), seed traceability Design column, then start Phase 4.
Blocked on: none

## Acceptance criteria (see traceability.md)
- [ ] AC1 Create a new project pointing at a local repo dir (existing — verify + regression-guard)
- [ ] AC2 Import a project by GitHub URL: clone locally, then create project from the clone
- [ ] AC2.1 Invalid/malformed URL rejected with clear error
- [ ] AC2.2 Clone failure surfaces clear error, no hang, no partial project
- [ ] AC2.3 New Project modal offers import-by-URL vs create-local

## Increments
- (to be planned in Phase 3)

## Assumptions
- Target repo is `cohort`. FACT: README + ProjectsPage.tsx.
- Design taken as-proposed without human sign-off (unattended one-shot). UNCONFIRMED.
- Q1 clone lands at <parent>/<repoName>, subdir must not exist. Q2 public HTTPS + ambient creds, GIT_TERMINAL_PROMPT=0. Q3 UX-level URL validation. UNCONFIRMED (clarifications.md).

## Log
- 2026-09-15 Phase 1 started; workspace created.
- 2026-09-15 G1 PASSED: research.md (delegated), 3 citations spot-checked OK; clarifications + traceability seeded.
- 2026-09-15 Phase 2: design.html written (delegated). Gate 2b design-review (delegated, different agent) = REVISE: 1 blocker (route has no GitService) + 3 majors. All fixed in design.html (standalone clone.ts helper; name normalization; z.preprocess back-compat; branch-before-validate). Gate 2b re-verdict APPROVE. Gate 2 taken as-proposed (unattended).
