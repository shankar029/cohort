# Live Brownfield Polyglot Validation Plan

**Goal:** Prove how Cohort's agents behave in a realistic **brownfield, polyglot,
multi-package** repo with **custom rules** (AGENTS.md/README/etc.) — across deep
root-cause debugging, SQL/data work, test-data feeds, build/release pipeline,
documentation, unit/integration tests, and ad-hoc chores. Not greenfield.
**Status:** Phase 0 DONE ✅ — fixture built + verified, seeded bug reproduces. Awaiting GO for Phase 1 live run.

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
- [ ] Phase 1 — live run tasks **1 (deep bug) + 4 (unit tests)** to validate the rig cheaply.
- [ ] Phase 2 — live run tasks 2,3,5,6,7 (some in parallel; also re-tests brownfield parallelism).
- [ ] Phase 3 — scorecard (`checker.mjs`, written at start of Phase 1) + findings ledger.

## Open defaults (override anytime)
- Phase 1 subset = tasks 1 + 4. Nested-rule gap probed deliberately = yes.

## Risks
- Token/time heavy — mitigated by phasing + offline zero-dep toolchain.
- .NET/Node experimental-sqlite flag needed in scripts (`node --experimental-sqlite`).
- Agents may ignore rules first pass — that IS the measurement; gates + checker catch it.
