# Design Review — Live greenfield smoke (design-first, real adapter)

Scope: independent DESIGN review of `.ai/live-greenfield-smoke/design.html` against research.md,
traceability.md, and the real seams in `evals/`, `src/server/orchestrator.ts`, `src/server/db/store.ts`,
`src/server/complexity.ts`, `src/server/agents/fakeAdapter.ts`. READ-ONLY; no code edited.

## Verdict: REVISE

The approach (extend the opt-in `evals/` harness, read the persisted design straight from sqlite, attribute
code by task-clone → stream) is well-grounded and right-sized. Symbols are real, isolation/boundedness holds,
and the two-mode self-test is genuine, not wishful. Three MAJORs must be closed before build: the `until`
early-stop is not derivable from what `monitorUntil` actually passes; the AC5 "stack" lexicon false-positives on
meta-words; and the AC4 fallback is not stream-attributed.

## Findings

| id | severity | location | issue | concrete direction |
|----|----------|----------|-------|--------------------|
| F1 | **blocker** | design §2/§4 `design-first` scenario `until`; harness.mjs `monitorUntil` | `monitorUntil(until,…)` calls `until(snap)` with ONLY the snapshot. "design persisted ∧ frontend produced code" needs `readEpicDesigns()` (DB) and `deliverablesByStream()` (clone diff) — neither is on `snap`, and scenarios are module-level constants that cannot close over the per-run `h`. As written the early-stop is unimplementable. | Either (a) change the runner to invoke `scenario.until(snap, h)` / bind `h`, so the predicate can call the two new methods; or (b) express early-stop purely from snapshot proxies: a `frontend`-stream task in `review`/`done` AND some `task.description` containing `<!--design-acceptance-->` (both are on the HTTP bundle). State the chosen seam explicitly. |
| F2 | major | design §4 AC5 "stack stated" regex | Lexicon includes meta-words `module|framework|stack`. The word "stack" alone passes — that is literally why the fake self-test goes green (fakeAdapter.ts:92 emits "…conventional **stack**…"). So a real design that says "our stack" without naming a concrete technology also passes → does NOT prove "a CONCRETE stack" (AC5). | Drop `stack|framework|module` from the pass lexicon; require ≥1 concrete-tech token (`react|vue|svelte|typescript|javascript|vanilla|node|vite|html|css|…`). Keep the meta-words only as a secondary/never-sole signal. |
| F3 | major | design §4 AC4 fallback ("frontend task terminal AND code deliverables exist") | `collectDeliverables()` is global across all clones; the fallback's "code deliverables exist" is NOT attributed to the frontend. Team is `[architect, frontend, qa]`; qa legitimately ships test code. If the frontend clone is GC'd having produced nothing while qa produced tests, the fallback passes AC4 falsely. | Attribute the fallback too: gate on the frontend agent's `committedFilesAheadOfBase`/`git "Committed … on ateam/task-…"` event (`detail.files`) for the frontend task, or on `deliverablesByStream().frontend` computed before GC. Do not accept unattributed global deliverables. |
| F4 | minor | design §4 AC5 lexicon (false-negative) | Lexicon is web/JS-centric; a legit greenfield choice like Python/Flask, Astro, Preact, Tailwind, esbuild wouldn't match. Acceptable for THIS web smoke, but brittle if the prompt drifts. | Note the constraint, or broaden to a small curated tech list; keep the epic prompt web-leaning so the lexicon stays valid. |
| F5 | minor | design §2 attribution notation `.tasks-<epicId>/wi_<taskId>` | Actual dir (git.ts:154-157) is `.tasks-<safeEpic>/<safeTask>` where `safeTask = id.replace(/[^A-Za-z0-9_-]/g,'').slice(0,24)`. Work-item ids are `wi_`+nanoid(12) = 15 chars (store.ts:34), so the dir basename **equals the full work-item id** (the `wi_` is part of the id, not an added prefix). Mapping basename → `snapshot.tasks[].id` → `.stream` is exact and recoverable — but the design's notation is imprecise and could mislead the implementer into stripping a prefix. | Reword to "dir basename === work-item id; look it up directly in `snapshot.tasks`." No prefix stripping. |
| F6 | minor / note | design §6; research §6 strand-on-question | No auto-answer. If the real model DOES raise a clarifying question (the exact AC4 failure under test), `raiseQuestion` waits on an in-memory promise; `until` never fires, so the run burns the FULL scenario timeout before reporting `userQuestionsRaised>0`. Bounded (no infinite hang) but costly. | Acceptable; consider an optional auto-answer or a shorter frontend-question-detected fast-fail so a stall doesn't consume the whole window. |
| F7 | note | design §6 readonly WAL read | `{readonly:true, fileMustExist:true}` from a second process against the server's live WAL db is safe for committed reads; `epic_designs` table exists from init (database.ts ~182) so `fileMustExist` holds; try/catch degrade-to-empty is correct. Low risk only if the scratch dir is writable (it is, under tmp) so SQLite can map `-shm`. | No change; keep the try/catch. |

## Per-AC coverage

- **AC4 (frontend decides + produces real code):** Primary signal (frontend task-clone diff, non-`.md`) is sound and
  stream-attributed — cloneDirs()/merge-base diff are real and the basename→stream map is exact (F5). The **fallback is
  the weak link (F3)**: unattributed global deliverables can pass on qa test code. `userQuestionsRaised` from
  `question.updated` events is derivable and correctly framed as reported-not-auto-fail. Verdict: covered once F3 tightens
  the fallback.
- **AC5 (concrete stack stated + design persisted before builders):** Persistence signal is exact — `epic_designs.content`
  via readonly read (store.ts:807-825), written in `designThenEnrich` (orchestrator.ts:~1283) before enrichment; the
  `<!--design-acceptance-->` marker is real, appended to `description`, published on `workitem.updated`, and present on the
  HTTP bundle (`toWorkItem` maps `description`+`stream`, store.ts:118/121). "Before builders act" is structurally enforced
  by `awaitEpicDesign` when an architect is on the team. **The one gap is the "concrete stack" bar (F2)** — the lexicon
  proves the word "stack", not a concrete technology. Verdict: covered once F2 tightens the lexicon.
- **AC-H (opt-in, bounded, isolated, no writes to cohort):** Fully covered. `ATEAM_FAKE_SDK` gate makes real adapter the
  default only without `--fake`; scratch port/DB/worktree under `os.tmpdir()/ateam-evals`; per-turn 15-min safety +
  scenario `defaultTimeoutMin`; target repo is greenfield-in-scratch and `worktreeRoot` is scratch, so nothing touches the
  cohort repo. `detectAuthIssue()` (real) fails loud. Only residual is F6 (stranded question burns the window, not the repo).

## Two-mode / Gate-4 self-test sanity (fake)

Real, not wishful. Under `--fake`: `classifyComplexity` returns `standard` on greenfield (complexity.ts:49) → `designThenEnrich`
runs; the fake matches `/per-stream task breakdown/i` and emits a non-empty design naming a "conventional **stack**" plus
`[stream] … :: …` lines (fakeAdapter.ts:80-98). Therefore `setEpicDesign` persists (→ `designPersisted` true; asserted by
designFirst.test.ts:94/115), the parse→enrich path appends `<!--design-acceptance-->` (→ `designEnrichedTasks` true;
designFirst.test.ts:86/110), the lexicon matches on "stack" (→ `designStatedStack` true), and the fake writes files in the
frontend clone (→ `frontendProducedCode` true). So the plumbing self-test genuinely exercises all four scoring fields.
Caveat: `designStatedStack` going green in fake is precisely the F2 false-positive — good for plumbing, insufficient as the
real "concrete stack" proof.

## Grounding

All named existing symbols are real: `report()`/`outcome` fields, `cloneDirs()`, `collectDeliverables()`,
`analyzeDelivery()`, `snapshot()` (tasks carry `id`/`stream`/`description`), `monitorUntil()`, `detectAuthIssue()`,
`epic_designs`/`setEpicDesign`/`getEpicDesign` (store.ts:805-825), the `<!--design-acceptance-->` marker
(orchestrator.ts:~1283-1305), greenfield→`standard` (complexity.ts:49). New symbols (`readEpicDesigns`,
`deliverablesByStream`, 7 outcome fields) are declared new and additive. No invented symbol found. Right-sizing is correct:
extending `evals/` (vs an HTTP route touching prod, or a vitest forced-fake in CI) is the minimal, faithful choice; the only
mild redundancy is 7 outcome fields where `frontendStreamTerminal`/`frontendProducedCode`/`streamsWithCode` overlap
(harmless).

---

## Parent dispositions (round 1) — REVISE addressed → proceed

- **F1 (blocker) — until can't reach DB/clone reads:** FIXED in design §6. `monitorUntil` will pass `this` (harness) as a 2nd arg to `until(snap, h)` (backward-compatible — existing unary untils ignore it); the `design-first` until does the cheap snapshot check first (epic done / frontend task terminal) and only then reads design/clones.
- **F2 (major) — stack lexicon meta-words:** FIXED §4. Dropped `stack|framework|module`; require a concrete technology token (html/css/js/ts/react/vue/svelte/node/vite/…). The fake self-test must now go green on a *named* technology, not the word "stack".
- **F3 (major) — AC4 fallback could credit qa/other code:** FIXED §4. Primary signal is frontend clone- OR `branch`-diff attribution; the fallback applies only when frontend clone/branch is gone AND frontend is the *sole* code-authoring builder (architect designs, qa tests), and requires a non-test code file. `streamsWithCode` exposes the attribution.
- **F4 (minor, JS-centric lexicon):** ACCEPTED + partially broadened (added express/fastify/tailwind/jest/vitest/playwright); the scenario deliberately asks for HTML/CSS/JS so a JS-leaning lexicon is appropriate.
- **F5 (minor, wi_<taskId> notation):** FIXED §2 — attribution maps by the clone dir's **exact basename == full task id**.
- **F6 (minor, no auto-answer burns timeout on a stall):** ACCEPTED by design — a stall is the bug under test and must surface, not be auto-answered/hidden; mitigated with a modest scenario timeout.
- **F7 (readonly WAL read is fine):** acknowledged.

Human sign-off: WAIVED — invocation "lets do the 1st one now" is unattended authorization; design taken as-proposed and recorded as an unconfirmed assumption (flagged in the final report). Independent design review was performed (this file).
Verdict after dispositions: proceed to Phase 3.
