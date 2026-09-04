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

## Phasing (cost control)
- [x] Phase 0 — build fixture + prove the seeded bug reproduces (free). **DONE.**
      Fixture at `C:\Code\Projects\ateam-bf` (git `baseline` tag). Baseline verified:
      `npm run typecheck` green, `npm test` 5/5 pass, `dotnet ... --selftest` OK,
      full pwsh build pipeline `BUILD OK`. Bug reproduces: `feed:import` drops 2 rows;
      API dau(2026-03-02)=**1** vs C# reporter(raw feed)=**3**.
- [x] Phase 1 — live run tasks **1 (deep bug) + 4 (unit tests)**. **DONE** — both merged, 3/3 tasks, 8/9 rules.
- [ ] Phase 2 — live run tasks 2,3,5,6,7 (some in parallel; also re-tests brownfield parallelism).
- [ ] Phase 3 — scorecard (`checker.mjs`, written at start of Phase 1) + findings ledger.

## Open defaults (override anytime)
- Phase 1 subset = tasks 1 + 4. Nested-rule gap probed deliberately = yes.

## Risks
- Token/time heavy — mitigated by phasing + offline zero-dep toolchain.
- .NET/Node experimental-sqlite flag needed in scripts (`node --experimental-sqlite`).
- Agents may ignore rules first pass — that IS the measurement; gates + checker catch it.
