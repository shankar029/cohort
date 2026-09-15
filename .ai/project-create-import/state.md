# project-create-import
Requirement: (1) Support for creating a new project (2) Support for importing a GitHub project by URL
Tier: standard
Branch: feat/project-create-import
Design: design.html · Plan: plan.html · Architecture: n/a
Traceability: traceability.md

Current phase: 4 — Implement (increment I2 of 2: Web UI + E2E)
Gates: G1 ✅ | G2 ✅ | G3 ✅ | G4 ✅ (I1) | G5 ⬜ | G6 ⬜
Next action: Add import-vs-local tabs to CreateProjectModal, widen web createProject to the union, wire URL + parent-folder inputs.
Blocked on: none

## Acceptance criteria (see traceability.md)
- [ ] AC1 Create a new project pointing at a local repo dir (existing — verify + regression-guard)
- [ ] AC2 Import a project by GitHub URL: clone locally, then create project from the clone
- [ ] AC2.1 Invalid/malformed URL rejected with clear error
- [ ] AC2.2 Clone failure surfaces clear error, no hang, no partial project
- [ ] AC2.3 New Project modal offers import-by-URL vs create-local

## Increments
- [x] I1 Backend: contracts + helpers + clone + service + route — green, committed (2f2acf1 amended). typecheck+lint clean; full suite 297 pass/1 skip (via --no-file-parallelism; parallel-load timeouts are pre-existing, proven on baseline).
- [ ] I2 Web UI + E2E ← current

## Notes
- Plan resized 3→2 increments (union type ripples through service+route — backend lands as one green slice).
- Extended isGitUrl to also accept file:// (valid git remote; enables offline real-clone tests). Superset of GitHub URLs; noted for report.
- Full-suite orchestration tests (delivery/parallel/regression/pr/orchestration/git) time out under default parallel load on THIS machine — confirmed on clean main too (1 fail/14 pass baseline). Use `npx vitest run --no-file-parallelism` for a clean green.

## Assumptions
- Target repo is `cohort`. FACT: README + ProjectsPage.tsx.
- Design taken as-proposed without human sign-off (unattended one-shot). UNCONFIRMED.
- Q1 clone lands at <parent>/<repoName>, subdir must not exist. Q2 public HTTPS + ambient creds, GIT_TERMINAL_PROMPT=0. Q3 UX-level URL validation. UNCONFIRMED (clarifications.md).

## Log
- 2026-09-15 Phase 1 started; workspace created.
- 2026-09-15 G1 PASSED: research.md (delegated), 3 citations spot-checked OK; clarifications + traceability seeded.
- 2026-09-15 Phase 2: design.html written (delegated). Gate 2b design-review (delegated, different agent) = REVISE: 1 blocker (route has no GitService) + 3 majors. All fixed in design.html (standalone clone.ts helper; name normalization; z.preprocess back-compat; branch-before-validate). Gate 2b re-verdict APPROVE. Gate 2 taken as-proposed (unattended).
- 2026-09-15 G3 PASSED: plan.html written; traceability Design/Task columns filled; branch feat/project-create-import created.
- 2026-09-15 Installed node_modules; baseline typecheck green.
- 2026-09-15 I1 implemented + G4 PASSED: typecheck+lint clean, full suite green (--no-file-parallelism). Committed 2f2acf1. package-lock drift reverted to origin.
