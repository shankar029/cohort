# Follow-up Fixes + UX Batch Plan

**Goal:** Land the run-#3 follow-up guardrails (deterministic, not model-trusted)
and 5 UX/product improvements, one verified commit per slice.
**Status:** in progress

## Part A — Deterministic guardrails (Option A follow-ups)
- [x] **A1 · FAITH-1 constraint gate.** New `src/server/constraints.ts`:
  deterministic `detectConstraints(texts)` (no-external-deps / in-memory / no-ui)
  + `checkClone(dir, constraints)` that scans a clone (runtime `dependencies`,
  non-builtin bare imports in non-test source, fs-write / db-lib usage, UI files).
  Wire into the per-task BUILD gate so a violation (e.g. `express` on a
  "built-in http only" task) blocks review — caught at build, before review.
- [x] **A2 · FAITH-3 scoped fix tasks.** `createFixTask`/`createAcceptanceFix`
  pick from `scopedSpecialists(epic)` (recompute `scopeStreams` from the epic
  description) so a headless epic never routes a fix to `ux`/`frontend`.
- [x] **A3 · Harness determinism.** Add the same constraint scan to the eval
  harness so evals assert faithfulness deterministically (task clones already
  scanned as of `755280c`).

## Part B — UX / product
- [ ] **B1 · Collapsible side nav.** Toggle + persisted (localStorage); icons-only
  collapsed state.
- [ ] **B2 · Chat: multiline + file upload.** Auto-growing textarea (Enter=send,
  Shift+Enter=newline), attach files (backend upload endpoint + storage), show
  attachments; pass attachment context to the Lead.
- [ ] **B3 · Work-item assignee.** Surface the assignee agent on the card/detail.
- [ ] **B4 · Per-project default model.** Project settings dropdown (from
  `/api/models`), persisted on the project, default for its agents.
- [ ] **B5 · Page-switch latency.** Profile nav while agents work; fix the
  blocking cause (heavy re-render / synchronous refetch / WS flood).

## Verification per slice
`npx tsc -p tsconfig.json --noEmit` · `npx eslint src tests --max-warnings 0` ·
scoped `prettier --check` · relevant vitest · (UI) targeted E2E/screenshot ·
commit `-F -`.

## Decisions log
- 2026-08-29 — no-external-deps enforced on RUNTIME deps + non-test imports only;
  dev tooling (vitest/tsc) allowed, matching "dependency-free runtime" intent.
