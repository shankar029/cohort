# Changelog

All notable changes to Cohort are documented here. This project adheres to
[Semantic Versioning](https://semver.org/). (Internal package name: `ateam`.)

## [0.1.0] - 2026-09-14

Inaugural release of **Cohort** — a local web app that orchestrates a team of
GitHub Copilot SDK agents (Team Lead + specialists) to take a request from intent
to a merged, verified result on its own git branch.

### Highlights
- **Agent team & catalog.** Team Lead orchestrator plus a catalog of specialized
  personas (PM, Architect, UX, Frontend, Backend, QA, DevOps, Docs, Researcher,
  Code Reviewer, Security Auditor, Data Engineer), each with a focused prompt and
  tool allow-list. Add from the catalog or create custom agents.
- **Per-agent skills.** Attach skills to each agent; an agent only follows the
  skills it was given (opt-in, enforced at the SDK level via `disabledSkills`).
  Catalog personas surface recommended-relevant skills without locking the
  choice; custom agents pick anything.
- **Epic orchestration & Kanban board.** Requests become epics, decomposed into
  dependency-ordered tasks across streams, run with safe parallelism, each in its
  own isolated git clone.
- **Deterministic verification gates.** Objective build/test/constraint gates plus
  a spec-derived acceptance probe and an LLM acceptance judge, with persisted,
  auditable gate reports and a shared per-epic remediation budget.
- **Peer review & merge authority.** Architect reviews each PR against the design;
  the epic merges only when review passes and the gates are green.
- **Web UI.** Cohort-branded interface: epic-grouped conversations, live activity
  feed, board with verification badges, agent detail pages, usage metrics,
  multiline composer with attachments, and light/dark + comic themes.

### Reliability & hardening
- Acceptance gate no longer false-fails on large diffs: the judge and reviewer now
  see the complete delivered file list, not a truncated slice.
- Fresh project repos are seeded with a default `.gitignore` so runtime artifacts
  (sqlite DBs, `node_modules`, logs) can't be committed or block merges.
- Reliable app boot-and-probe primitive (`probe_app`) for shell-capable
  specialists, with atomic teardown.
- Lead no longer dead-ends idle after a rejected/blocking tool call; tool
  allow-lists are enforced at the SDK level so agents are never offered a tool
  they can't use.
- Self-healing for stalled epics (leaked-guard recovery), converge-or-escalate
  review budget, and more auto-recovery re-drives before escalating an
  integration conflict.
- Deterministic hard-constraint gate with scope-constrained fix tasks;
  constraint detection hardened against quoted string / internal-workspace
  false positives.
- Commit-aware work detection (fixes "produced nothing" / empty-epic cases);
  configurable Conventional-Commits style; nested repo-instruction discovery.

### Validated
- Live real-SDK runs covering parallel epics/projects, brownfield polyglot
  monorepos, full-stack cross-layer delivery, and end-to-end acceptance.
- Unit + integration suite: 261 passing.

[0.1.0]: https://github.com/shankar029/cohort/releases/tag/v0.1.0
