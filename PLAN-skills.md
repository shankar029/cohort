# Per-Agent Skills — Plan

**Goal:** Let users attach skills to each agent so an agent only follows the skills it was
given (curated defaults for catalog personas, free choice for custom agents), with the
enforcement, capability checks, and observability to keep runs predictable.

**Status:** Phases 1–2 shipped & pushed; Phase 3 skipped; Phases 4–5 deferred.

## Key findings (grounded in code + Copilot SDK types)
- Skill plumbing already exists: `Agent.skills: string[]`, `skillScanner.discoverSkills()`,
  `GET /api/projects/:id/skills`, create+update APIs accept `skills[]`, store persists it.
- **Custom-agent UI already has a skills multi-select** (all discovered, flat) — matches the
  "custom agents pick anything" intent. **Catalog agents get NO skill choice today.**
- **Bug:** per-agent selection is NOT enforced. `orchestrator.ts` passes the dirs of *all*
  discovered skills to *every* agent session (`skillDirectories(discoverSkills(...))`), and the
  default agent has no per-agent `skills` field — so `agent.skills` is carried but ignored.
- **SDK reality (`@github/copilot-sdk` types.d.ts):**
  - `skillDirectories?: string[]` (session) = discovery pool.
  - `disabledSkills?: string[]` (session, line 2143) = "List of skill names to disable." ← clean,
    **name-granular** scoping lever for the default agent (no sibling-dir leak).
  - `skills?: string[]` eager-preload exists **only on `CustomAgentConfig`** (line 1405), NOT on
    `DefaultAgentConfig` (line 1424). Cohort runs every agent as the *default* agent (persona via
    `systemMessage`), so native always-on injection would require restructuring to `customAgents`.

## Decisions
- **v1 scoping = `disabledSkills`** (Path A). Keep `skillDirectories` = all discovered (names
  resolve), and disable every skill NOT in `agent.skills`. Name-granular, opt-in (empty = none),
  zero schema change, no architecture change. Chosen over restructuring to `customAgents` (Path B).
- **Always-on vs on-demand:** v1 ships the SDK's on-demand/progressive-disclosure model scoped per
  agent. True eager injection ("always follow") = **deferred Path B** (customAgents), only if the
  on-demand model proves too soft. Recommendation stands: revisit after we see live behavior.
- **Catalog vs custom (per user):** catalog agents get curated `suggestedSkills` as *recommended
  defaults, not a lock*; custom agents get the full flat list (already the case). Real enforcement
  moves to **capability** (skill-vs-tools) not persona relevance.
- **Live server:** idle (epic merged). Core edits hot-reload the idle :5319 session — low risk;
  verify with full suite + tsc/lint. Stop the dev server on request.

## Steps
- [x] 1. **Phase 1 — per-agent scoping (`disabledSkills`).** `adapter.ts` add
  `disabledSkills: string[]`; `orchestrator.ts` compute `all-minus-selected` and pass it;
  `realAdapter.ts` forward to `createSession`. Unit test: config carries exactly the unselected
  names as disabled; selected stays enabled. No schema change. ✅ 2026-09-07 — extracted pure
  `scopedDisabledSkills()` helper; +4 unit tests; suite 256 pass/1 skip; tsc+lint clean; live
  server healthy after hot-reload.
- [x] 2. **Phase 2 — curate + catalog UI.** Populate `suggestedSkills` per role; add a
  recommended-skills selector when adding a catalog agent (pre-check present suggested, "show all"
  for the rest); allow editing skills on an existing agent (PATCH already supports it). ✅ 2026-09-07
  — curated `suggestedSkills` for 9 roles (applied only if a skill of that name is present); catalog
  "Add" now auto-attaches recommended-present skills + shows a "Recommends: …" hint (one-click add
  preserved for e2e); shared recommended-aware `SkillPicker` (recommend, don't restrict) reused by
  the custom form + agent editor; editor derives recommendations from the agent's catalog persona.
  Pure `partitionRecommended`/`recommendedPresent` helpers + 5 unit tests. Suite 261 pass/1 skip;
  tsc+lint clean; vite build clean. (Edit-skills-on-existing-agent already existed.)
- [-] 3. **Phase 3 — capability validation.** SKIPPED 2026-09-07 — real `SKILL.md` files declare
  only `name`/`description` (no `allowed-tools`), so a skill-vs-tools warning would essentially
  never fire today. Revisit if/when skills adopt tool declarations.
- [ ] 4. **Phase 4 (deferred) — observability.** Emit a skill-enabled/invoked event so runs stay
  auditable.
- [ ] 5. **Phase 5 (deferred) — always-on eager injection.** Restructure agent sessions to
  `customAgents` with per-agent `skills` for guaranteed "always follow." Only if Phase 1's
  on-demand model is insufficient.

## Risks & rollback
- Behavior change: after Phase 1, an agent with no attached skills gets NONE (opt-in). Catalog
  agents currently ship `skills: []` → they'd get zero until Phase 2 curates `suggestedSkills`.
  Mitigate by landing Phase 2 curation close behind, or accept opt-in as the correct default.
- SDK `disabledSkills` behavior is native (not JS-inspectable); verify empirically that a disabled
  skill is not offered. Unit-test the config; live-confirm on a later run.

## Decisions log
- 2026-09-07 — Chose `disabledSkills` (Path A) over `customAgents` restructuring (Path B) for v1
  scoping: name-granular, no schema/architecture change, matches opt-in model.
