# Independent Review + Requirement Verification — project-create-import

**Reviewer:** Independent code Reviewer + Requirement Verifier (fresh context; did NOT author this code).
**Repo:** `C:/code/projects/cohort` · **Branch:** `feat/project-create-import` @ `6ef8e28` vs `origin/main`.
**Mode:** READ-ONLY. No `src/**` or test files were edited. Only this `review.md` was written.

## Checks run (read-only)
| Check | Command | Result |
|-------|---------|--------|
| Feature unit+integration | `npx vitest run tests/unit/importUrl.test.ts tests/integration/importProject.test.ts --no-file-parallelism` | **36 passed** (exit 0) |
| Typecheck | `npm run typecheck` (`tsc -p tsconfig.json --noEmit`) | **clean** (exit 0) |
| Lint | `npm run lint` (`eslint . --max-warnings 0`) | **clean** (exit 0) |

I re-derived all findings from the tree (api.ts, clone.ts, services.ts, app.ts, ProjectsPage.tsx, state.tsx, and the 3 test files), not from the author narrative.

---

## Findings table

| # | Issue | Severity | Location | Suggested direction |
|---|-------|----------|----------|---------------------|
| 1 | `summarizeCloneError` has three tailored branches (auth / not-found / network) but only the generic `Clone failed:` fallback is asserted by tests (`/clone failed/i`). The three specific messages are unverified — a regression in those regexes would pass CI. Since mutation was skipped (UI project), nothing else guards them. | Low | `services.ts:130-149` | Add a small unit test table feeding representative stderr strings and asserting each mapped sentence. Pure function, trivial to cover. |
| 2 | `deriveRepoName` strips a trailing `.git` **before** stripping trailing slashes, so a URL ending `.../repo.git/` yields dir name `repo.git` (the `.git` survives). Cosmetic only; `isGitUrl` still accepts such URLs so it can reach this path. | Low | `services.ts:74-77` | Strip trailing slashes first, then `.git` (or loop). Not a correctness/security issue — folder just keeps `.git` suffix. |
| 3 | Clone arg order is `['clone', url, name]` with no `--` end-of-options separator. `execFile` (no shell) already prevents shell injection, and `isGitUrl` rejects `-`/`ext::`/option-looking strings, so argument-injection is blocked at the schema boundary — but the guard is validation, not a hard barrier. Given the app already browses the whole local FS single-user, this is acceptable. | Info | `clone.ts:31` | Optional hardening: insert `'--'` before `url`. Not required. |
| 4 | `importProjectFromUrl` does an `existsSync(target)` check then clones — a TOCTOU window exists. Irrelevant for a local single-user app, and `git clone` itself refuses a non-empty target as a backstop. | Info | `services.ts:110-116` | No action needed; note only. |
| 5 | Project `name` collisions are not de-duplicated at the store level for imports (same as pre-existing local-create behavior). Out of scope for this feature. | Info | `services.ts` | No action; pre-existing behavior, consistent with local path. |

No blockers. No band-aids, skips, tautological assertions, or gamed metrics were found.

---

## Scrutiny notes (as requested)

- **`isGitUrl`** — Correctly accepts https/http/ssh/git/file + scp-style (`user@host:path`); rejects empty, plain text, scheme-less, host-without-path, unsupported schemes (`ftp:`), and Windows drive paths (`C:\...` parses as protocol `c:` → not in allow-list). scp regex `^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:.+$` uses simple bounded char classes → **no ReDoS**. Correctly excludes Windows paths because they lack `@`. Verified by the accept/reject table in `importUrl.test.ts` (all pass). Correctly framed in the doc comment as UX validation, not a security boundary.
- **`cloneRepoToDir`** — Non-throwing contract honored: resolves `{ ok, path, stderr }` in both success and `err` paths, never rejects. `GIT_TERMINAL_PROMPT=0` present → fail-fast, no credential-prompt hang (proven: two independent `< 15000ms` assertions on the failure path). Partial-dir cleanup via `fs.rmSync(targetPath, {recursive, force})` in the error branch, wrapped in try/catch; verified by "leaves no partial dir" assertion. `execFile` with an args array (no shell) → no command injection.
- **`importProjectFromUrl`** — `name` is resolved to `input.name?.trim() || deriveRepoName(url)` and guarded (`if (!name) throw`), so it is **never undefined** before `createProjectWithLead`. Parent-dir existence/type validated, then **target-exists guard fires BEFORE the clone**. Failure paths throw `ProjectImportError` and return **before** any store write, so no project row is created on failure (verified: `listProjects()` length 0 in all failure tests).
- **Route (`app.ts`)** — Branches on `input.source === 'import'` **before** `validateRepoDir`; the import path never touches `repoDir`. `ProjectImportError → HttpError(400)`; non-import errors re-thrown. Response shape `{ project, agents }` with status 201 and `bus.publish({type:'project.updated'})` is **identical** to the local branch. Global error handler returns `{ error: message }` (app.ts:118-119) — matches the test assertion on `.error`.
- **Schema back-compat** — `z.preprocess` injects `source:'local'` only when the body is a plain object lacking `source`, before the discriminated union reads the discriminator. AC1 body `{name, repoDir}` parses to a valid local input; verified both at schema level (unit) and end-to-end via the route "source omitted → local" test (201, one project).
- **Web modal** — Tablist with `role="tab"`/`aria-selected` and `data-testid` hooks; default `local`. Client-side `isGitUrl(repoUrl)` gate before submit with a clear inline message. Payload is mode-correct (`import` → `{source, name|undefined, repoUrl, parentDir, defaultModel}`; `local` → `{source, name, repoDir, defaultModel, createDir}`). Field state is separated (`repoUrl`/`parentDir` vs `repoDir`); `name`/`model` are intentionally shared; `setError(null)` on each tab switch prevents stale-error leakage. The `does not exist` auto-tick-createDir helper is correctly gated to `mode === 'local'`. FolderPicker reused for both modes with mode-aware target. No state leakage that changes the submitted payload.
- **Test authenticity** — Tests perform a **real `git clone`** of a **real fixture repo** (`git init` + real commit) over a `file://` URL, with real filesystem assertions (`.git`, `README.md` present) and real store assertions. The `file://` happy-path is a legitimate offline proof of "clone by URL": it exercises the identical `git clone <url> <name>` codepath with a genuine transport URL, differing from https only in the remote endpoint. Failure tests use a genuinely missing `file://` source to drive the real error/cleanup/no-hang path. No mocks, stubs, skips, or tautologies.

---

## Per-AC reconciliation (re-derived from final code + tests)

| AC | Requirement | Evidence (code + test) | Verdict |
|----|-------------|------------------------|---------|
| **AC1** | Local create regression preserved | `z.preprocess` back-compat (api.ts:56-66); route local branch unchanged (app.ts:172-176); unit "body without source → local" + integration "source omitted → 201, 1 project" both pass | **VERIFIED** |
| **AC2** | Import-by-URL clones then creates | `cloneRepoToDir` (clone.ts) → `importProjectFromUrl` → `createProjectWithLead` (services.ts:82-113); route returns 201 `{project,agents}` (app.ts:159-171); integration "imports a project… provisions Team Lead" asserts cloned `.git` under parent + Team Lead + 1 project; e2e navigates into project and confirms on-disk clone | **VERIFIED** |
| **AC2.1** | Invalid URL rejected with clear error | Server: `isGitUrl` refine in schema (api.ts:49) → 400 before any git call (integration test, 0 projects); Client: `isGitUrl` gate + inline message (ProjectsPage.tsx:245-248), e2e asserts inline error + no navigation | **VERIFIED** |
| **AC2.2** | Clone failure → clear error, no hang, no partial project | `GIT_TERMINAL_PROMPT=0` (clone.ts:39), partial cleanup (clone.ts:47-52), no store write on failure (services.ts); integration asserts 400 + `/clone failed/i` + 0 projects + `< 15000ms` + no partial dir; target-exists guard also 400 no-clobber | **VERIFIED** |
| **AC2.3** | Modal offers import vs local | Tablist with two tabs + mode-switched fields (ProjectsPage.tsx:288-322); e2e "offers Local vs Import tabs" asserts field visibility toggles per tab | **VERIFIED** (via e2e; not covered by the run-here vitest scope — see metrics note) |

---

## Metrics note

`metrics.json` reports `project: "ui"`, `verdict: pass`, and lists `mutation_score_pct` (and duplication/complexity/cycles/dead_exports/static_findings) as **unavailable/skipped** for the UI project. Judgment on whether test assertions compensate for the missing mutation coverage of the **changed backend logic**:

- The backend surface (`isGitUrl`, `deriveRepoName`, schema discrimination/back-compat, `cloneRepoToDir`, `importProjectFromUrl`, route branching) is covered by **real** assertion-bearing tests exercising accept/reject tables, real clone success, real clone failure with cleanup + no-hang, target-exists no-clobber, and AC1 back-compat — this is strong behavioral coverage that a mutation run would largely have caught anyway.
- The one genuine gap left by skipping mutation is **finding #1**: the three tailored `summarizeCloneError` branches are not individually asserted (only the fallback). A mutant flipping those regexes would survive. Low severity (message-quality only; the 400 + no-partial-project behavior is independently proven).
- AC2.3 (UI tabs) is verified by e2e/Playwright only; the vitest scope run in this review does not exercise it. The e2e evidence (`verification.md`, `e2e-full.log`) records 3 passed.

Net: test assertions **adequately** cover the changed backend logic despite the skipped UI mutation run; the residual risk is limited to unasserted error-message wording.

---

## Overall verdict: **APPROVE**

The change is minimal, coherent, and faithful to the design: a standalone non-throwing `cloneRepoToDir` deliberately kept off `GitService`, a clean `ProjectImportError → HTTP 400` mapping, back-compat via `z.preprocess`, and an unchanged response shape. All five acceptance criteria reconcile as VERIFIED against the final code and tests; typecheck, lint, and the feature test suite are green. The only follow-ups are low/informational (assert the `summarizeCloneError` branches; tidy the `.git`-trailing-slash edge in `deriveRepoName`). None block merge.

---

## Parent dispositions (round 1)
- **Finding #1 (summarizeCloneError branches unasserted) — FIXED** (d0cb715): exported `summarizeCloneError` and added a unit table asserting the auth / not-found / network / fallback branches. Closes the mutation gap.
- **Finding #2 (deriveRepoName `.git/` edge) — FIXED** (d0cb715): strip trailing slashes before `.git`; `repo.git/` → `repo`. Added a unit case.
- **Finding #3 (`--` end-of-options) — FIXED** (d0cb715): `git clone -- <url> <name>` (defensive; `execFile`+`isGitUrl` already blocked injection).
- **Findings #4 (TOCTOU) / #5 (name de-dup) — no action**: info-only, irrelevant for a local single-user app / pre-existing behavior consistent with local create.

Verdict stands: **APPROVE**. All 5 ACs VERIFIED. Post-fix: feature suite 41 passed, typecheck + lint clean.
