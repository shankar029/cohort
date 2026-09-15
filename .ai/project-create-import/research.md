# Research: Project Create + GitHub Import

**Commit SHA:** `87762392b86a5fb52eb1560ed25805257d5fb454` (`git rev-parse HEAD`)
**Scope:** Cohort — Fastify server + React web, TypeScript, better-sqlite3.
**Requirement:** (1) create a new project; (2) import a GitHub project by URL (clone repo → create project from it).
**Evidence policy:** every claim carries `path:line`; every "not implemented" carries the search that came up empty. Claims typed FACT / INFERENCE / HYPOTHESIS / UNKNOWN.

---

## 1. Summary

- **FACT** — Project creation is fully implemented end to end: web modal → app-state action → API client → zod schema → Fastify `POST /api/projects` → `validateRepoDir` → `createProjectWithLead` → SQLite store. A folder-picker (`GET /api/fs/dirs` / `listDirs`) lets the user browse local directories, and a `createDir` flag can create the target directory. Creation takes an **existing local directory only** — there is no notion of a remote/URL source.
- **FACT** — GitHub import (clone-by-URL) is **not implemented anywhere**. `git.ts` has a rich `GitService` git-CLI wrapper, but every `clone` call targets a **local path** (`repoDir` / another local clone), never a URL; no route, schema, service, or UI accepts a repository URL.
- **INFERENCE** — Import attaches at six seams that already exist for create: the zod schema (`src/shared/api.ts`), the `POST /api/projects` route (`src/server/app.ts`), the `createProjectWithLead` service (`src/server/services.ts`), a **new** clone-by-URL helper in `GitService` (`src/server/git.ts`), the API client (`src/web/api.ts`), and the `CreateProjectModal` UI (`src/web/pages/ProjectsPage.tsx`).
- **FACT** — Git is invoked via `execFile('git', args, …)` wrapped in a promise (`git.ts:70-93`); it is **async**, never throws on non-zero exit (returns `{ ok, stdout, stderr }`), and forces `GIT_AUTHOR_*`/`GIT_COMMITTER_*` env. `windowsHide: true`, `maxBuffer: 10MB`. **No auth/credential handling for remote fetch exists** (nothing pushes to a remote today).
- **FACT** — Conventions: zod at the route boundary, `ZodError`→400 and a custom `HttpError`→its status via a single Fastify error handler; lint is strict (`eslint . --max-warnings 0`), `no-explicit-any` is `warn`. Vitest (unit + integration) + Playwright e2e exist; `validateRepoDir`, `listDirs`, and `GitService` clone-isolation all have tests.

---

## 2. What is implemented (creation flow, cited)

### Web modal
- `src/web/pages/ProjectsPage.tsx:222-266` — `CreateProjectModal` holds state `name`, `repoDir`, `model`, `createDir`, `error`, `busy`, `browsing` (`:235-241`). Fields: project name (`:282-286`), repo dir with a **Browse** button (`:296-315`), a "create this directory" checkbox (`data-testid="project-createdir"`, `:318-325`), and a model select (`:330`).
- `src/web/pages/ProjectsPage.tsx:243-264` — `submit` calls `onCreate({ name, repoDir, defaultModel: model, createDir })` then navigates to `/p/${project.id}/agents`. Error UX: if the message matches `/does not exist/i` and `createDir` is false, it auto-ticks `createDir` and prompts the user to click again (`:254-259`); otherwise shows the raw message.
- `src/web/pages/ProjectsPage.tsx:353-356` + `:370-...` — a `DirBrowser` overlay drives folder selection via `api.listDirs`.

### App state
- `src/web/state.tsx:295-300` — `createProject` context type: `{ name; repoDir; defaultModel?; createDir? }`.
- `src/web/state.tsx:476-480` — `createProject` calls `api.createProject(input)`, dispatches `UPSERT_PROJECT`, returns the project.

### Web API client
- `src/web/api.ts:60-64` — `createProject(input)` → `POST /api/projects` with JSON body.
- `src/web/api.ts:175-181` — `listDirs(path?)` → `GET /api/fs/dirs?path=…`.
- `src/web/api.ts:38-57` — generic `request<T>` helper: sets `Content-Type` only when a body is present, parses JSON, and on `!res.ok` throws `Error(body.error ?? 'Request failed (status)')`. **This is how the web surfaces server errors** — the string in `error` becomes the thrown message the modal displays.

### Shared schema / types
- `src/shared/api.ts:9-16` — `createProjectSchema = z.object({ name (1-80), repoDir (min 1), defaultModel? , createDir? })`; `CreateProjectInput = z.infer<…>`.
- `src/shared/domain.ts:58-62` — `interface Project { … repoDir: string … }` (repoDir is a required local path field).

### Server route + filesystem browser
- `src/server/app.ts:159-167` — `POST /api/projects`: `createProjectSchema.parse(req.body)` → `validateRepoDir(input.repoDir, input.createDir === true)` → on `!ok` `throw new HttpError(400, check.error)` → `createProjectWithLead(store, config, input, check.resolved)` → `bus.publish({type:'project.updated'})` → `reply.status(201)` → returns `{ project, agents }`.
- `src/server/app.ts:52-108` — `listDirs(dir?)`: returns drives/home roots when no dir (Windows enumerates drive letters `A:`–`Z:`), else sub-directories (hides dotfiles), throwing `HttpError(400, …)` on unreadable/non-dir paths.
- `src/server/app.ts:145-151` — `GET /api/fs/dirs` handler wrapping `listDirs`. Comment notes this is a **local app** where server and user share one machine.
- `src/server/app.ts:34-38` — `class HttpError extends Error { status; message }`.
- `src/server/app.ts:111-123` — Fastify `setErrorHandler`: `ZodError`→400 `{error:'Validation failed', details}`; `HttpError`→`err.status {error}`; else 500.

### Services
- `src/server/services.ts:17-39` — `validateRepoDir(repoDir, createIfMissing=false)`: `path.resolve`, `fs.statSync`; not-a-dir → `{ok:false,'Path is not a directory'}`; missing + `!createIfMissing` → `{ok:false,'Directory does not exist'}`; missing + create → `fs.mkdirSync(recursive)` → `{ok:true, created:true}`. **Synchronous, local FS only.**
- `src/server/services.ts:42-63` — `createProjectWithLead(store, config, input, resolvedRepoDir)`: resolves model, `store.createProject({ name, repoDir: resolvedRepoDir, settings:{ defaultModel, approvalMode:'auto-workspace', extraSkillRoots:[], recordSessions? } })`, then `store.createAgent({ …TEAM_LEAD_TEMPLATE, model })` and `store.ensureMainThread(project.id)`.

### DB store
- `src/server/db/store.ts:403-420` — `createProject({ name, repoDir, settings })`: builds a `ProjectRow` with `id('prj')`, timestamps, `INSERT INTO projects (...)`, returns `toProject(row)`. Synchronous (better-sqlite3), per class doc `store.ts:395-399`.

**Data flow:** modal → `state.createProject` → `api.createProject` → `POST /api/projects` → `createProjectSchema.parse` → `validateRepoDir` → `createProjectWithLead` → `store.createProject` + team-lead agent + main thread → `201 {project, agents}` → `UPSERT_PROJECT` → navigate.

---

## 3. What is not implemented (GitHub import — absence searches)

- **FACT (absent)** — No clone-by-URL / GitHub handling anywhere:
  `rg -n -i "clone.*https?://|github\.com|importProject|cloneFromUrl|clone_url" src/ tests/` → **NO MATCHES**.
- **FACT (absent)** — No URL/remote import concept:
  `rg -n -i "import.*repo|repoUrl|remoteUrl" src/` → only unrelated hits (`app.ts:22` a TS `import`, `constraints.ts:152` prose, `BoardPage.tsx:3` a TS `import`). No `repoUrl`/`remoteUrl` field.
- **FACT** — Every `GitService` clone targets a **local path**, not a URL:
  - `src/server/git.ts:169-172` — `createEpicWorktree`: `git clone --no-hardlinks --quiet <repoDir> <dir>` (repoDir is a local project dir).
  - `src/server/git.ts:245-248` — `createTaskWorktree`: clones `epicClonePath` (local).
  There is **no** general "clone this URL into a chosen directory" method.
- **FACT** — `createProjectSchema` (`src/shared/api.ts:9-16`) has **no** URL/source-type field; the modal (`ProjectsPage.tsx:222-266`) has **no** import tab/URL input — only name + local repoDir + createDir.
- **INFERENCE** — Import is therefore a **new capability**, not a config toggle: it needs (a) accept a URL, (b) clone to a local dir via git, (c) then run the existing create path against the cloned dir.

---

## 4. Constraints & conventions

- **Validation (FACT):** zod schemas live in `src/shared/api.ts`, parsed at the route with `schema.parse(req.body)` (`app.ts:160`). Inferred types (`CreateProjectInput`) are the single source shared by web + server.
- **Error→HTTP (FACT):** single `setErrorHandler` (`app.ts:111-123`): `ZodError`→400 (`{error, details}`), `HttpError`→its status (`{error}`), else 500 with the error message. Domain errors are raised as `throw new HttpError(status, message)` (`app.ts:162`).
- **Web error surfacing (FACT):** `request<T>` throws `Error(body.error)` on non-2xx (`api.ts:51-55`); the modal shows `err.message` (`ProjectsPage.tsx:253-260`). So a clone-failure message must arrive in the response `error` string to be user-visible.
- **Git exec (FACT):** `GitService.run` (`git.ts:70-93`) uses `execFile('git', args, {cwd, windowsHide:true, maxBuffer:10*1024*1024, env:{…GIT_AUTHOR/COMMITTER…}})`, promise-wrapped, **non-throwing** (`{ok, stdout, stderr}`). Callers throw on `!ok` (e.g. `git.ts:172`). All mutating ops are guarded to stay under `worktreeRoot` (e.g. `git.ts:196-201`, `:432-437`). **No credential/token handling** exists for authenticated remotes; nothing is pushed to a remote (class doc `git.ts:41-49`).
- **Filesystem (FACT):** local-only; `validateRepoDir` and `listDirs` use `node:fs` synchronously; the app assumes server and user share one machine (`app.ts:147-149`).
- **TS/lint (FACT):** `npm run lint` = `eslint . --max-warnings 0` (`package.json:17`); `no-explicit-any`=`warn`, `no-unused-vars`=`error` with `^_` ignore (`eslint.config.js:14-22`). `npm run typecheck` = `tsc --noEmit` (`package.json:16`). `@shared` alias → `src/shared` (`vitest.config.ts:6-8`).
- **Naming (FACT):** IDs via `id('prj')` (`store.ts:406`); project settings default `approvalMode:'auto-workspace'`, `extraSkillRoots:[]` (`services.ts:49-54`).

---

## 5. Existing tests

- **Framework (FACT):** Vitest, `environment:'node'`, includes `src/**/*.test.ts` + `tests/{unit,integration,live}/**` (`vitest.config.ts:9-20`). Coverage thresholds (80% lines/fn/stmt, 70% branch) enforced over core incl. `src/server/git.ts` and `src/server/db/store.ts` (`vitest.config.ts:24-40`).
- **Create-path unit tests (FACT):**
  - `tests/unit/validateRepoDir.test.ts:12-45` — accepts existing dir, rejects missing (no create), creates recursively when asked, rejects a file path.
  - `tests/unit/fsBrowse.test.ts:20-47` — `listDirs`: sub-dirs only/sorted/skip dotfiles, parent reporting, roots listing, throws on missing/file.
- **Git tests (FACT):** `tests/integration/git.test.ts:45-...` — epic gets its own isolated **local clone** + branch (`:46-90`), parallel epics get separate clones (`:92-124`), discard/revert epic (`:126-...`), per-task build gate + final acceptance gate. All exercise **local-path** clones; none cover URL clone.
- **E2E (FACT):** Playwright `testDir:'./tests/e2e'` with a `webServer` (`playwright.config.ts:6,17-20`); specs incl. `app.spec.ts`, `_createdir.spec.ts`, `_cohort.spec.ts`, `_about.spec.ts`, `_followups.spec.ts`, `coverage.spec.ts`. `_createdir.spec.ts` likely covers the create-dir modal flow (HYPOTHESIS — named for it; not opened).
- **No import tests (FACT):** the absence searches in §3 return no clone-by-URL coverage.

---

## 6. Seams (exact files + functions to extend for import)

1. **Schema** — `src/shared/api.ts:9-16` `createProjectSchema` / `CreateProjectInput`: add a source discriminator or a `repoUrl` field (shared web+server type).
2. **Git helper** — `src/server/git.ts` `GitService` (class at `:52`; existing local clones at `:169-172`, `:245-248`): add a **clone-from-URL** method (async, returns `{ok,stdout,stderr}` pattern; must decide target dir + guard/auth). This is the only new git capability required.
3. **Service** — `src/server/services.ts`: `validateRepoDir` (`:17-39`) and `createProjectWithLead` (`:42-63`) — an import service would clone the URL to a local dir, then reuse `createProjectWithLead` with the cloned path.
4. **Route** — `src/server/app.ts:159-167` `POST /api/projects` (or a sibling import route): branch on source, invoke clone, map failures to `HttpError`.
5. **API client** — `src/web/api.ts:60-64` `createProject` (add/extend for import URL).
6. **UI** — `src/web/pages/ProjectsPage.tsx:222-266` `CreateProjectModal`: add a create-vs-import tab and URL input; `state.tsx:295-300,476-480` `createProject` action type/impl.

---

## 7. Blast radius

- **Shared types** (`src/shared/api.ts`, `domain.ts`) are consumed by both server and web via `@shared`; a schema change ripples to `state.tsx`, `api.ts`, and `ProjectsPage.tsx`. (FACT — imports at `api.ts:1-24`, `services.ts:3-4`.)
- **`POST /api/projects` response shape** `{project, agents}` is consumed by `state.createProject` (`state.tsx:477`) — additive changes are safe; shape changes ripple.
- **`GitService`** is central to orchestration (epic/task clones, merges); adding a method is low-risk, but it is under the 80% coverage gate (`vitest.config.ts:30`) so a new method needs tests.
- **Filesystem assumptions**: cloning writes to the local disk under a user-chosen dir; must respect the existing local-only, `worktreeRoot`-guarded conventions and avoid touching managed clone roots.

## 8. Risks & unknowns (typed)

- **UNKNOWN** — Target directory policy for a URL clone: does import clone into the user-picked `repoDir` (must be empty?) or a derived subdir? No existing rule covers "clone into a chosen empty dir" (create path only validates an existing/creatable dir — `services.ts:17-39`).
- **UNKNOWN** — Authentication for private GitHub repos. No token/credential handling exists in `GitService` (`git.ts:70-93` sets only author/committer env); public HTTPS clone may work, private/SSH is unaddressed.
- **UNKNOWN** — URL validation/allow-listing (SSRF/arbitrary-host risk): no URL is accepted anywhere today, so no validation precedent exists.
- **RISK** — `execFile('git', …)` is non-throwing; a clone failure must be explicitly detected (`!ok`) and mapped to an `HttpError` so the message reaches the web (`api.ts:51-55`). Missing this yields a silent/opaque 500.
- **RISK** — Long clones vs. Vitest/HTTP timeouts (`testTimeout:20000`, `hookTimeout:20000`, `vitest.config.ts:18-19`); large-repo clone may exceed test/UX budgets.
- **RISK** — `git` CLI must be on PATH; DEVELOPMENT.md lists Node/Copilot prereqs but not a standalone git requirement for import (docs/DEVELOPMENT.md:9-14). (FACT — git assumed present because `GitService` shells out to it.)
- **HYPOTHESIS** — `_createdir.spec.ts` covers the create-dir modal path and is the closest e2e template for an import spec (named for it; not opened).
