# Live Brownfield Polyglot Validation Plan

**Goal:** Prove how Cohort's agents behave in a realistic **brownfield, polyglot,
multi-package** repo with **custom rules** (AGENTS.md/README/etc.) — across deep
root-cause debugging, SQL/data work, test-data feeds, build/release pipeline,
documentation, unit/integration tests, and ad-hoc chores. Not greenfield.
**Status:** Phase 1 DONE ✅ — both epics merged, scorecard captured. Awaiting GO for Phase 2.

## Phase 1 RESULTS (real copilot-sdk, project `prj_-h_RZvZe_LTf`, 2 concurrent epics)
Both epics merged (peak 2 concurrent epics). Scorecard vs `baseline` on the merged repo:
- **Gates 4/4**: npm install, typecheck, `npm test` **24 pass** (was 5 — agents added ~19 tests), C# `--selftest` OK.
- **Tasks 3/3**: deep bug FIXED — API dau(2026-03-02) now **3** (matches C# reporter); root cause correctly
  identified as the over-strict `VALID_TS` regex in `packages/dataio/src/importer.ts` (fixed to accept
  optional seconds/fractional + `Z`|`+00:00`) — **not** a date-specific hack. Core tests cover all 6 exports.
- **Rules 8/9 honored** (root AGENTS.md injected): R1 no-throw ✓, R2 entrypoints ✓, R3 node --test/BCL ✓,
  R4 named exports ✓, R5 generated untouched ✓, R7 CHANGELOG+docs updated ✓, R8 migrations append-only ✓,
  R9(core pure) ✓.

### Findings
1. **Brownfield parallelism re-confirmed** — 2 epics concurrent in one project, both merged clean.
2. **Deep root-cause debugging works** — agent used the cross-language API-vs-reporter clue, traced 3 hops to
   the ETL, fixed the real cause, added a regression test. Gate stayed green.
3. **R6 (Conventional Commits) “fails” — but it's the HARNESS, not the agents.** All non-conforming commits are
   Cohort-generated (`ateam: merge`, `ateam: integrate`, `task(role): …`). ⇒ a repo mandating Conventional
   Commits is violated by Cohort's own commit style regardless of agents. **Actionable:** make commit messages
   configurable / CC-compliant.
4. **Nested per-package instruction files are NOT ingested (confirmed in `context.ts`).** Discovery = fixed root
   `INSTRUCTION_FILES` + dirs `.cursor/rules`, `.github/instructions`, no recursion. `packages/core/AGENTS.md`
   (R9) was never injected; compliance was coincidental. 16 KB total / 6 KB per-file cap confirmed.
5. **Recordings not written under the real adapter (`bf-rec` empty)** — enable for Phase 2 to prove which rules
   were injected vs dropped by the 16 KB cap.

## Verified toolchain (this machine, offline / no network installs)
- Node **v24** (built-in `node:sqlite` works ✅) + npm.
- .NET **9** — BCL-only build/run works offline ✅ (no NuGet).
- PowerShell 7 + bash + git. **Missing:** Python, Go, Java, sqlite3 CLI, make.
- ⇒ Polyglot mix = **TS/Node + C#/.NET + PowerShell/Bash + SQL(node:sqlite)**.

## What Cohort ingests today (verified in `context.ts`)
- Root instruction files: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`,
  `.windsurfrules`, `.github/copilot-instructions.md`, `CONVENTIONS.md` +
  `.cursor/rules/`, `.github/instructions/`. Injected as MANDATORY into every agent.
- Caps: 6 KB/file, 16 KB total. Read from the agent's cwd (the epic clone).
- **Suspected gaps to probe:** (a) nested/per-package `AGENTS.md` NOT discovered
  (root-only); (b) 16 KB truncation drops later rules; (c) monorepo command/scope
  selection; (d) injection ≠ obedience.

## Fixture: `ateam-bf` (polyglot metrics monorepo, offline, ground-truth)
```
AGENTS.md CONVENTIONS.md README.md CHANGELOG.md
.github/workflows/ci.yml  .github/instructions/data-rules.md
package.json (npm workspaces)  tsconfig.base.json
db/ schema.sql  migrations/0001_init.sql  generated/schema.d.ts(DO NOT EDIT)  seed/events.csv
scripts/ gen-feed.mjs  build.sh build.ps1  release.sh release.ps1
packages/core/     (TS) result+types, UNDER-TESTED, nested AGENTS.md (probe)
packages/dataio/   (TS) importer.ts(SEEDED DEEP BUG) queries.ts db.ts + tests
packages/api/      (TS) node:http service + service.ts + tests
packages/reporter/ (C#) Program.cs BCL-only, reads raw feed export, --selftest
docs/architecture.md
```
**The deep bug:** importer normalizes event day-buckets and dedups by (user,day);
a subtle parse/normalization defect silently drops valid rows ⇒ API's daily-active
counts read LOW. C# reporter counts from the raw feed ⇒ correct/higher. The
API-vs-reporter mismatch is the only surface clue; root cause is 3 hops away in the
ETL, not the API or the SQL query.

## Custom rules (machine-checkable) in root AGENTS.md
1. No `throw` in `api`/`dataio` — return `Result<T,E>` from `@repo/core`.
2. Import only package entrypoints (`@repo/core`), never deep `.../src/...`.
3. TS tests: `node --test` ONLY (no vitest/jest/mocha). C#: repo `--selftest`, no NuGet.
4. Named exports only — no `export default` in TS.
5. Never edit `db/generated/**` (DO-NOT-EDIT header).
6. Conventional Commits for every commit.
7. Behavior change ⇒ update package `CHANGELOG.md` + relevant `docs/`.
8. Migrations are append-only & numbered — never edit an existing migration.
(One extra rule lives only in `packages/core/AGENTS.md` to probe nested discovery.)

## Task matrix (each a separate request → epic)
1. **Very deep debug + fix** — the importer bug (root cause, regression test).
2. **SQL/data** — add `weekly-active` metric (new query + append-only migration + wire TS+C#).
3. **Test data feeds** — extend `gen-feed.mjs` (date range, edge cases) + import test.
4. **Unit-test epic** — comprehensive `node --test` for `core`.
5. **Build & release pipeline** — fix release scripts (bump C# + changelog) + CI to build/test both langs.
6. **Documentation** — document pipeline + metrics API in docs/README (accurate).
7. **Ad-hoc** — rename `dau` → `dailyActive` across TS + C# + SQL + docs consistently.

## Measurement: `checker.mjs` (run vs each merged result)
- Gates: `npm test` (node --test workspaces), `tsc -b`, `dotnet run -- --selftest`.
- Rule scorecard: grep/git checks for rules 1–8 + conventional-commit log +
  generated-file untouched + migration append-only.
- Task correctness: seeded-bug regression (bad feed ⇒ corrected counts), new metric
  values, docs sections present, rename completeness (no stale `dau`).
- Nested-rule probe: was `packages/core/AGENTS.md` rule honored? (expected: no.)

## Interlude — Full-stack CROSS-LAYER debugging + collaboration test (real copilot-sdk)
Project `prj_r4PhmYjBz4dz` on fixture tag `baseline-fs` (adds a browser dashboard `packages/web` +
`/metrics/range`). Seeded a bug whose SYMPTOM is in the UI but whose root causes span two layers,
with the backend as an honest pass-through to be ruled out:
- **Data** (`dataio/src/queries.ts`): `activeInRange` used `day < to` (exclusive) → dropped the last day.
- **Frontend** (`web/public/format.js`): `computeTotal` seeded `reduce(…, '')` → string-concat total ("232").

**Outcome:** epic merged (1 PR, 11 commits, 8 files). Scorecard: **Gates 3/3**, **Cross-layer fixes 3/3** —
data now `day <= to` (range=3 days, total **7**), frontend `reduce(…, 0)` (numeric **7**). Layers touched:
web+api+dataio. Added `web/tests/dashboard.e2e.test.ts` + extended tests + CHANGELOG/docs.

### How the agents collaborated (observed via /threads, /messages, board, /pr-comments)
- **3 threads** used: `main` (user↔team; status updates + the architect's design post), a primary
  **`group:Team discussion`** (21 msgs — the coordination backbone), and a topic-scoped
  **`group:Daily Active Users full-stack`** (localization discussion that concluded with an explicit **Decision**).
- **Lead** (agt_GTXG, 11 msgs) orchestrated: plan → status updates → moderated decision. Message counts:
  qa 6, backend 5, architect 5, frontend 4, reviewer 3, user 1.
- **Cross-layer localization worked**: the architect posted “two independent root causes, two different
  layers — the backend is innocent,” correctly naming RC-1 (data `day < to`) and RC-2 (frontend concat)
  BEFORE coding. The Lead’s Decision: “fix both together.”
- **Decomposition pattern**: Cohort assigned the *implementation* to ONE owner (backend) rather than
  splitting per-layer; collaboration happened in the group thread + review, not via parallel per-layer tasks.
- **Quality gate caught shallow work** — the review pass raised **2 BLOCKING** findings that spawned two
  corrective tasks, both merged: (1) QA: “the frontend regression test does not actually verify the fix”;
  (2) reviewer: “the CHANGELOG documents only the range fix” (missing the frontend fix). Board grew
  3 → 5 tasks, all `done`; **2 PR comments** filed.

**Takeaways:** (a) role agents genuinely collaborate through Lead-moderated group threads + a shared board,
and the review loop meaningfully hardens output (rejected an inadequate test + incomplete changelog).
(b) For a cross-layer bug, Cohort localizes collaboratively but tends to hand the fix to a single engineer.
Artifacts: `ateam-live/bf-fs-collab.log` (transcript), `bf-fs-check.mjs` (scorecard), `bf-fs-run.mjs` (observer).

- [x] Phase 2 — live run tasks 2,3,5,6,7 (separate clones, 2 waves ≤3 concurrent). **DONE — 4/5 merged.**

## Phase 2 RESULTS (real copilot-sdk; each task in its own clone off `baseline-fs`)
Wave 1 = t2/t3/t6 concurrent; Wave 2 = t5/t7 concurrent. Every merge went through a strict,
rule-aware review loop that filed BLOCKER findings and drove rework.

| Task | Type | Result | Evidence |
|---|---|---|---|
| **t2** | SQL/data — `weekly-active` | ✅ **merged, PASS** | `weeklyActive('2026-03-01')`→`{to:'2026-03-07',weeklyActive:4}`; new `db/migrations/0002_*.sql` (append-only R8 ✓); generated untouched (R5 ✓); gate 14/14 |
| **t3** | Test data feeds | ❌ **did NOT converge** | reviewer raised 5+ BLOCKERs; epic spiraled into more subtasks, a `todo` fix-task went unstarted, all agents (incl. Lead) went **idle**; a user nudge re-planned but still didn't merge |
| **t5** | Build/release pipeline | ✅ **merged, PASS** | `release.sh 0.2.0` bumps root+`Reporter.csproj`+CHANGELOG; `ci.yml` gains dotnet reporter build/selftest; gate 9/9 |
| **t6** | Documentation | ✅ **merged, PASS** | `docs/pipeline.md` (98 lines) covers `/health`,`/metrics/daily-active`,`/metrics/range` + all 5 packages; gate green |
| **t7** | Ad-hoc rename `dau`→`dailyActive` | ✅ **merged, PASS** | 0 residual `dau` in src/public/reporter/docs; endpoint field now `dailyActive` (across TS+C#+web+docs); gate 9/9 |

### Phase 2 findings
- **Review gate is genuinely rigorous** — it caught a wrong response field name + a missing migration (t2),
  missing CHANGELOG + missing integration test (t3), etc., and blocked merge until fixed. Quality is real.
- **NEW robustness finding (t3): epics can fail to converge and stall.** Under a heavily-specified brief the
  reviewer over-decomposed into many BLOCKER subtasks; the epic didn't reach merge, a `todo` fix-task was left
  unstarted, and the Team Lead's manager loop went **idle** instead of finishing/merging. A user nudge caused
  MORE tasks (spiral) rather than convergence. → logged as backlog **F1** (Group F).
- **Cross-clone multi-project parallelism held** — 3 then 2 projects ran concurrently without interference.

## Phasing (cost control)
- [x] Phase 0 — build fixture + prove the seeded bug reproduces (free). **DONE.**
      Fixture at `C:\Code\Projects\ateam-bf` (git `baseline` tag). Baseline verified:
      `npm run typecheck` green, `npm test` 5/5 pass, `dotnet ... --selftest` OK,
      full pwsh build pipeline `BUILD OK`. Bug reproduces: `feed:import` drops 2 rows;
      API dau(2026-03-02)=**1** vs C# reporter(raw feed)=**3**.
- [x] Phase 1 — live run tasks **1 (deep bug) + 4 (unit tests)**. **DONE** — both merged, 3/3 tasks, 8/9 rules.
- [x] Phase 2 — live run tasks 2,3,5,6,7 (some in parallel; also re-tests brownfield parallelism). **DONE (4/5 merged; t3 stalled).**
- [ ] Phase 3 — fix consolidated backlog (Groups A–F), then re-verify.

## Open defaults (override anytime)
- Phase 1 subset = tasks 1 + 4. Nested-rule gap probed deliberately = yes.

## Risks
- Token/time heavy — mitigated by phasing + offline zero-dep toolchain.
- .NET/Node experimental-sqlite flag needed in scripts (`node --experimental-sqlite`).
- Agents may ignore rules first pass — that IS the measurement; gates + checker catch it.
