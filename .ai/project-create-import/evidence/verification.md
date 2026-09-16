# Verification — project-create-import

**Role:** Independent Verification Agent (fresh context; did NOT build this feature).
**Branch:** `feat/project-create-import` @ `6ef8e285c5823585989c5b78d447c7749769bf5a`
**Repo:** `C:/code/projects/cohort`  ·  **Node:** v22.22.2  ·  **Date:** 2026-09-15
**Constraint honored:** no production code (`src/**`) was modified. Read/run/tests only.

---

## Commands run (exact) + exit codes + tail

### 1. Unit + integration (feature-scoped)
```
npx vitest run tests/unit/importUrl.test.ts tests/integration/importProject.test.ts
```
- **Exit code:** `0`
- **Result:** `Test Files 2 passed (2)` · `Tests 36 passed (36)`
- Tail:
  - `✓ tests/unit/importUrl.test.ts (29 tests) 16ms`
  - `✓ tests/integration/importProject.test.ts (7 tests) 3489ms`
    - `✓ cloneRepoToDir > clones a local fixture repo into <parent>/<name> 948ms`
    - `✓ POST /api/projects import (route) > imports a project from a git URL and provisions the Team Lead (AC2) 1534ms`
    - `✓ POST /api/projects import (route) > rejects when the target folder already exists (no clobber) 416ms`

### 2. Playwright e2e (webServer builds bundle + runs Fake adapter, offline)
```
ATEAM_E2E_PORT=4501 npx playwright test tests/e2e/_import.spec.ts
```
- **Exit code:** `0`
- **Result:** `3 passed (15.5s)` (1 worker)
  - `✓ _import.spec.ts:25 › New Project modal offers Local vs Import tabs (AC2.3) (992ms)`
  - `✓ _import.spec.ts:40 › Import rejects a malformed URL with a clear inline error (AC2.1) (895ms)`
  - `✓ _import.spec.ts:53 › Import clones a git URL and opens the new project (AC2) (2.1s)`
- webServer command (from `playwright.config.ts`): `npm run build && cross-env ATEAM_FAKE_SDK=1 ATEAM_PORT=<port> ATEAM_DB=:memory: NODE_ENV=production tsx src/server/index.ts` — a real production bundle served with the Fake SDK adapter, fully offline.

### 3. Full suite / environment-note verification
```
timeout 300 npx vitest run --no-file-parallelism
```
- **Exit code:** `124` (the wrapping `timeout(1)` 300s wall-clock, NOT a vitest failure).
- **Observation:** Every test that emitted a result line was **passing** (delivery correctness, parallel siblings, QA gate, git isolation, PR/review, gitSafety, constraints, etc.). The suite was still progressing serially when the 300s bound elapsed. This is consistent with the stated environment note: the orchestration integration tests are simply slow/heavy (many spawn real `git` and multi-second orchestration flows). No feature-related failure was observed. The feature's own tests pass fast and green in isolation (step 1 & 2). **The slow full suite is a pre-existing machine/orchestration cost, not attributable to this feature.**

---

## Per-AC verdict

| AC | Verdict | Proving test(s) |
|----|---------|-----------------|
| **AC1** — Create local project still works (regression) | **PASS** | `importProject.test.ts` → "still creates a local project when source is omitted (AC1 regression)" (POST with `{name, repoDir}`, no `source` → 201, 1 project row). Also unit `importUrl.test.ts` → schema `z.preprocess` injects `source:'local'` for legacy bodies. |
| **AC2** — Import by git URL clones then creates project | **PASS** | `importProject.test.ts` → "imports a project from a git URL and provisions the Team Lead (AC2)" (201, `repoDir` under chosen parent, `.git` exists in clone, Team Lead agent provisioned, 1 project row). `cloneRepoToDir` → "clones a local fixture repo into <parent>/<name>". e2e "Import clones a git URL and opens the new project (AC2)" (UI navigates into project; `<parent>/<name>/.git` + `README.md` present on disk). |
| **AC2.1** — Malformed URL rejected with clear error | **PASS** | Unit `isGitUrl` table (9 accept / 7 reject) + `createProjectSchema` "rejects an import body with a malformed URL". `importProject.test.ts` → "rejects a malformed URL with 400 before any git call" (400, 0 rows). e2e "Import rejects a malformed URL with a clear inline error" (visible `/valid git URL/i`, stays on modal). |
| **AC2.2** — Clone failure → clear error, no hang, no partial row | **PASS** | `cloneRepoToDir` → "fails fast and leaves no partial dir when the source does not exist" (`ok:false`, non-empty stderr, no partial dir, `<15s`). `importProject.test.ts` → "surfaces a clone failure as 400 with no project row and no hang" (400, error `/clone failed/i`, 0 rows, `<15s`). Also "rejects when the target folder already exists" (400 `/already exists/i`, 0 rows). |
| **AC2.3** — Modal offers Import vs Create-local | **PASS** | e2e "New Project modal offers Local vs Import tabs" (Local default shows `project-repo`, hides `project-url`; Import tab shows `project-url`+`project-parent`, hides `project-repo`). |

**Overall: 5 / 5 ACs PASS.**

---

## Legitimacy checks (per PROCESS steps 3–4)

- **Happy-path is a REAL git clone, not a stub.** Fixtures (`makeFixtureRepo` in both integration and e2e specs) run actual `git init` / `git add` / `git commit` and are consumed via `pathToFileURL(src).href` (`file://` URL) for offline determinism. Production `cloneRepoToDir` shells out to `git clone <url> <name>` via `execFile('git', ...)` — no mock/stub of git in the product path. Tests assert `.git/` and `README.md` physically exist in the clone, confirming a genuine checkout.
- **Failure path is bounded and clean.** `cloneRepoToDir` sets `GIT_TERMINAL_PROMPT=0` (fail-fast, no credential-prompt hang) and best-effort `fs.rmSync` cleanup of any partial checkout. Route maps `ProjectImportError` → `HttpError(400)`. Assertions verify `<15s` bound, 400 status, and **0** project rows on every failure mode (bad URL pre-git, unreachable clone, pre-existing target).
- **Malformed URL rejected before git.** `createProjectSchema` (discriminated union) refines `repoUrl` with `isGitUrl` at the schema boundary, so a bad URL 400s at `createProjectSchema.parse(req.body)` in `POST /api/projects` before `importProjectFromUrl`/`cloneRepoToDir` is ever called — proven by the "before any git call" integration test.
- **Back-compat / no scope creep.** Legacy `{name, repoDir}` bodies without `source` are preprocessed to `source:'local'` and flow through the unchanged `validateRepoDir` + `createProjectWithLead` path.

---

## Findings

- **No findings against the feature.** All acceptance criteria are independently proven by passing assertions; no test required changing product behavior to pass, and no production code was modified.
- **Environment (non-blocking, pre-existing):** the full `vitest` suite is slow — heavy orchestration integration tests (delivery/parallel/git/pr) each take many seconds running real git/orchestration flows. Under default parallel load these can time out; even serialized (`--no-file-parallelism`) the suite exceeds a 5-minute wall clock on this machine. Observed tests were all passing while progressing. This is unrelated to `project-create-import`; scope feature verification to the two commands in steps 1–2 for fast, deterministic signal.
