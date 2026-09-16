# Design Review — Project create + GitHub import

**Reviewer:** Independent Design Review Agent (fresh context, read-only over source).
**Design under review:** `.ai/project-create-import/design.html`
**Repo:** `C:/code/projects/cohort` @ research commit `8776239`.

---

## Verdict: **REVISE**

All five acceptance criteria map to named components, and every *existing* symbol
the design names is real. But there is one **feasibility blocker** (the route
cannot reach a `GitService` as the design's signatures require) plus two design
concerns worth fixing before build. None rise to REJECT: no AC is uncovered and
no named existing symbol is fabricated — the gaps are omissions the design must
close, not fictions.

---

## Findings

| # | Finding | Severity | Principle / AC | Suggested direction |
|---|---------|----------|----------------|---------------------|
| 1 | **`importProjectFromUrl(store, config, git, input)` is not feasible as written: the route has no `GitService`.** `buildApp(ctx: AppContext)` destructures `{ store, bus, orchestrators, recorder, config }` (`app.ts:110`); `AppContext` (`app.ts:24-31`) has **no `git` field**. In `index.ts` the `GitService` is constructed (`index.ts:34`) and passed **only** to `OrchestratorManager` (`index.ts:44`), **not** to `buildApp` (`index.ts:49-56`). The only git reach from a route today is indirect via `orchestrators.get(id).gitSnapshot()` (`app.ts:335-338`). So the `POST /api/projects` branch cannot obtain `git` to pass to `importProjectFromUrl`. | **Blocker** | Concern B; Interface feasibility (rubric 4); AC2 | Either (a) thread `git` into `AppContext` + `buildApp` + the `index.ts` call site, or (b) — cleaner, see #2 — make clone a **standalone module-level function** (e.g. `cloneRepoToDir(url, parent, name)`) that needs no `GitService` instance, so the route/service imports it directly. The design must state which and update the signature. |
| 2 | **`GitService.cloneRepo` violates the class's documented invariant.** The `GitService` class doc states "All operations are scoped to managed clones under `worktreeRoot` … nothing is pushed to a remote" (`git.ts:41-49`); the constructor takes only `worktreeRoot`/`commitStyle` (`git.ts:52-57`); `commitWork` even hard-guards paths to `startsWith(worktreeRoot)` (`git.ts:185-188`). A URL clone into a **user-chosen parentDir outside `worktreeRoot`** breaks the single responsibility ("managed epic/task clones") and the invariant. The design's own decision table acknowledges the URL "writes outside that root" yet still bolts the method onto `GitService`. | **Major** | Concern A; SRP / cohesion (rubric 3); AC2 | Extract a small standalone clone helper (module function in `git.ts` or a new `clone.ts`) that wraps `execFile('git', ['clone', …])` and returns the existing `{ ok, stdout, stderr }` shape. Keeps `GitService`'s worktree invariant intact and resolves #1 at the same time (no instance needed). If kept on `GitService`, the class doc must be rewritten — larger blast radius, not recommended. |
| 3 | **Type-safety gap: `createProjectWithLead` reads `input.name`, which is optional in the import branch.** `createProjectWithLead` does `name: input.name` (`services.ts:44-47`) and `store.createProject` expects a required `name`. The design's `importSchema` makes `name` `…optional()` ("default: derived repo name"). On the discriminated union `CreateProjectInput`, `input.name` is therefore `string | undefined`, and nothing in the design guarantees it's populated **before** the reused create call — a real `tsc`/runtime gap (empty project name). | **Major** | Concern C; Interface correctness (rubric 4); AC2 | Have `importProjectFromUrl` construct a *normalized* local-shaped input with `name` resolved via `deriveRepoName` (never undefined) before calling `createProjectWithLead` — and/or narrow the type at that boundary so TS proves `name` is present. State this explicitly in the design's data-flow. |
| 4 | **`z.discriminatedUnion('source', …)` with a defaulted discriminator may not preserve back-compat for callers that omit `source`.** The design claims `source` "defaults to `'local'` so existing callers stay valid," using `z.literal('local').default('local')`. Zod reads the **discriminator key before applying member defaults**; an input with `source` absent can fail to match any union member (throwing `ZodError`→400) rather than defaulting to local. Existing integration tests / any body without `source` could break — the opposite of the claimed additive/back-compat guarantee. | **Major** | Grounding of a claimed behavior (rubric 2); Testability (rubric 6); AC1 regression | Verify the zod version's behavior explicitly. Safer: pre-process (`z.preprocess`/`.catch`) to inject `source:'local'` when missing, or keep a top-level `source` default outside the union, or update all existing callers to send `source` and drop the back-compat claim. Cover with a "POST without source still creates local" test. |
| 5 | **Current route unconditionally reads `input.repoDir` / calls `validateRepoDir` before any branch.** `app.ts:159-162` does `validateRepoDir(input.repoDir, …)` first; the import variant has no `repoDir`. The design's "to-be branches on `source`" covers this, but the branch must happen **before** `validateRepoDir` so the import path never touches `input.repoDir`. Flagged to ensure the implementer moves the branch above the current line 160, not after. | **Minor** | Edge handling (rubric 5); AC2 | Design/tasks should show the branch as the first statement after `parse`, with the local path (validate→create) in the `else`. |
| 6 | **Good grounding on the folder picker.** The design names `FolderPicker` as the reused component; that is the **real** component (`ProjectsPage.tsx:352, 365`) — research's "DirBrowser" label was the imprecise one. No action; noting the design is correct here. | Correct | Grounding (rubric 2); AC2.3 | — |

---

## Rubric assessment

1. **Requirement coverage — PASS.** AC1 → `validateRepoDir`+`createProjectWithLead` (regression-guard, real: `services.ts:17,42`). AC2 → `importProjectFromUrl`+clone+reuse. AC2.1 → `isGitUrl` refine in `importSchema`. AC2.2 → non-throwing clone `{ok:false}` → `HttpError`, `GIT_TERMINAL_PROMPT=0`, no store write, pre-existing-target guard. AC2.3 → `CreateProjectModal` local/import tabs. Every AC maps to a named component.
2. **Grounding — PASS with caveats.** Verified real: `createProjectSchema`/`CreateProjectInput` (`api.ts:10-17`), `GitService` + private `run()` + local clone methods (`git.ts:52,70,169,245`), `createProjectWithLead`/`validateRepoDir` (`services.ts`), `HttpError`+`setErrorHandler` (`app.ts:33,113`), `POST /api/projects` (`app.ts:159`), `FolderPicker` (`ProjectsPage.tsx:365`), web `request`/`createProject` (`api.ts:39,63`), `state.createProject` (`state.tsx:295-300`). **The one un-grounded assumption is #1: `git` is *not* in `AppContext`.**
3. **SOLID / right-sizing — one SRP violation (#2).** Otherwise well right-sized: single route + discriminated union (vs a separate import route) is a reasonable, defended trade-off; `deriveRepoName` as a pure helper is appropriately small.
4. **Interface quality — the clone/service signatures are clean but currently infeasible (#1) and have a type gap (#3).**
5. **Error/edge handling — strong.** Invalid URL (zod refine), auth hang (`GIT_TERMINAL_PROMPT=0`), partial clone (fatal `ok:false`, no store write, best-effort cleanup noted), target-exists (pre-check), git-not-on-PATH (`execFile` error → `ok:false`, actionable message + doc note). Good coverage of the failure matrix.
6. **Testability / security / performance — adequate for a local single-user app.** Mockable `GitService`/clone helper; sync-HTTP clone acknowledged with a tiny-fixture-repo mitigation vs the 20s test timeout; URL validation correctly framed as UX not a security boundary. Verify #4 with a back-compat test.
7. **Readability — PASS.** Skimmable in ~5 min; module + sequence diagrams carry structure; as-is→to-be section makes the delta explicit; `unverified` spans are honestly marked.

---

## What must change to reach APPROVE
- Resolve **#1** (make `git`/clone reachable from the route — prefer the standalone helper, which also fixes **#2**).
- Close the **#3** name-type gap explicitly in the import service.
- Validate/repair the **#4** discriminated-union default so AC1 does not regress.

Once #1–#4 are addressed the design is sound and buildable; #5 is a one-line clarification and #6 is already correct.

---

## Parent adjudication & dispositions (round 1 → APPROVE-equivalent)

All findings accepted and folded into `design.html`:

- **#1 (blocker) — FIXED.** Route cannot reach a `GitService`. Design now uses a **standalone
  `cloneRepoToDir` in a new `src/server/clone.ts`** (own `execFile` wrapper), imported directly by
  the service. No `buildApp`/`AppContext` wiring change.
- **#2 (major) — FIXED.** URL clone kept **off** `GitService`; its worktree invariant is unchanged.
- **#3 (major) — FIXED.** `importProjectFromUrl` resolves `name = input.name?.trim() ||
  deriveRepoName(url)` (never undefined) and builds a local-shaped input before
  `createProjectWithLead`; TS proves `name` present. New `ImportProjectInput` type exported.
- **#4 (major) — FIXED.** Schema wrapped in `z.preprocess` that injects `source:'local'` when
  absent, before the discriminated union reads the key; a back-compat test ("POST without source
  creates local") is in the test strategy.
- **#5 (minor) — FIXED.** Data section states the handler branches on `input.source` first; import
  branch never touches `validateRepoDir`/`repoDir`.
- **#6 — no action (design already correct on `FolderPicker`).**

Verdict after revision: **APPROVE** (residual items #4 behavior + #3 typing to be proven by tests
in Phase 4/5). Gate 2b passed.

## Gate 2 (human sign-off)
Invocation is an unattended one-shot delivery ("do not stop until the Definition of Done is met"),
which authorizes proceeding without blocking for sign-off. Design taken **as proposed**; the design
and the three Q1–Q3 assumptions (clarifications.md) are recorded as **unconfirmed** and flagged in
the final report and PR. agent-browser unavailable → render self-check was structural HTML
validation only.
