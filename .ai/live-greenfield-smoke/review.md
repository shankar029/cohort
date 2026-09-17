# Independent Review — live-greenfield-smoke (feat/live-greenfield-smoke)

Reviewer: independent (fresh context, READ-ONLY on code; wrote only this file).
Commits under review: `3c217fa` (harness+scenario+self-tests), `d07bb54` (live evidence).
Scope of diff: `git diff main...HEAD -- evals/ package.json` (+ `.ai/**` docs/evidence).
Verified this session: `src/**` diff EMPTY; 7/7 self-tests pass; `npm run lint` clean;
`npm run typecheck` clean.

## Bottom line
**APPROVE** — the harness, evidence, and verdicts are sound and honest. "APPROVE"
here means the verification apparatus is trustworthy and the recorded outcome is
correct; it does **not** mean AC4/AC5 pass (they do not, live). The task correctly
measured a **true-negative** and root-caused it to prior product code (PR #4), not
to the harness. No product code was touched.

## Findings

| id | severity | location | issue | direction |
|----|----------|----------|-------|-----------|
| F1 | none (good) | `git diff main...HEAD -- src` | Product code UNTOUCHED — verification task stayed in `evals/` + docs only. | — |
| F2 | none (good) | `evals/harness.mjs` `STACK_RE` | Meta-word "stack" is NOT in the lexicon; requires a concrete tech (html/css/react/…). Selftest asserts "conventional stack" → false. No F2 false-pass. | — |
| F3 | none (good) | `scoreDesignFirst` `frontendFallback` | Fallback fires only when FE terminal + real code landed + FE is the SOLE builder stream (`builderStreams.every(===frontend)`); a co-present backend/other builder blocks the credit. Selftest asserts the ambiguous case → false. Not gamed. | — |
| F4 | low | `evals/harness.mjs` `deliverablesByStream` (branch-based attribution loop, `searchDirs`) | The clone-GC/branch-diff fallback path is NOT exercised by any self-test (only the task-clone `branch:null` path is). Unasserted branch. It degrades safely (`try/catch → []`), so this is defense-in-depth, not a correctness risk. | over-engineered-but-safe / add-test-later |
| F5 | low (cosmetic) | `scoreDesignFirst` `streamsWithCode` | Counts QA `*.test.js` as "code" by extension (documented in the selftest). Only affects the informational `streamsWithCode` render line; AC4 uses `frontendAttributedCode` which excludes `TEST_RE`. No scoring impact. | note-only |
| F6 | none (good) | `evals/harness.mjs` L341 `until(snap, this)` | Signature change is backward-compatible — legacy scenarios use `(s)=>` and ignore the extra arg; only `design-first` consumes `h`. `smoke --fake` regression intact. | — |
| F7 | none (good) | `readEpicDesigns` | Opens sqlite `{ readonly:true, fileMustExist:true }`, wrapped in try/catch/finally → never writes, never crashes scoring; degrades to `[]`. Safe against the server WAL. | — |
| F8 | none (good) | `evals/run.mjs` L324/L336, `makeGreenfieldRepo` | Greenfield target is created under `h.scratch/target` (OS temp), DB/worktree/port all scratch-scoped; the cohort repo (`REPO_ROOT`, used only as server `cwd`) is never a write target. Bounded via `defaultTimeoutMin` + `ATEAM_DESIGN_TIMEOUT_MS`. | — |
| F9 | note | whole task | Mutation testing skipped (UI/infra project); scoring is instead protected by 7 true-path self-tests over real temp git + sqlite. Reasonable substitute; noted per instruction. | note-only |

## Scoring correctness (is `scoreDesignFirst` honest / not gamed?)
- **AC5 `designStatedStack`** genuinely EXCLUDES the meta-word "stack" (F2) and
  requires a concrete technology token. Verified by reading `STACK_RE` and by the
  passing selftest `AC5: a concrete stack passes; the meta-word "stack" alone does not`.
- **AC5 `designPersisted`** requires a non-empty trimmed `epic_designs.content` —
  cannot be satisfied by an empty architect turn (exactly what the live runs hit).
- **AC4 `frontendProducedCode`** = primary attribution (code diffed to the frontend
  stream, tests excluded) OR the F3 guarded fallback that refuses credit when any
  other builder could have authored the code. Both true-paths are asserted.
- **False-pass risk:** none found — every path that flips a check to PASS requires
  real persisted design content or real code attributable/attributed to frontend.
- **False-fail risk:** low — `readEpicDesigns`/`deliverablesByStream` degrade to
  empty on error, which biases toward NOT-VERIFIED, not toward a fake PASS. Given
  the verdict IS not-verified, this is the safe direction and does not undermine
  the true-negative (the empty-turn root cause is independently corroborated by the
  events, below).
- **Self-tests are real, not tautological:** they build a temp git repo (init →
  commit → branch → commit) and a real sqlite `epic_designs` table, then assert the
  true code-attribution and read-only DB paths. 7/7 pass (`node --test`).

## Honesty of the verdicts (does evidence support "AC4/AC5 NOT-VERIFIED live"?)
Corroborated end-to-end and NOT over-claimed:
- run1 & run2 `outcome.json`: `designPersisted=false`, `designStatedStack=false`,
  `designEnrichedTasks=false`, `frontendProducedCode=false`, `frontendStreamTerminal=false`,
  `userQuestionsRaised=1`, `completed=false`, `authIssue=false` — identical signal
  across both runs (run2 only raised `ATEAM_DESIGN_TIMEOUT_MS` to 240s and widened
  the window; same outcome → rules out "slow, not empty").
- **Root cause substantiated in code:** `orchestrator.ts` `designThenEnrich`
  computes `const text = (raw ?? '').trim(); if (!text) return;` (line ~1281) BEFORE
  `setEpicDesign(...)` — an empty/tool-only architect turn is a silent no-op, so
  `epic_designs` stays empty and no `<!--design-acceptance-->` enrichment occurs.
- **Root cause substantiated in events** (`run1/events.jsonl`): the architect thread
  emits `chat.message` with `content:""` alongside `usage.updated turns:1` (a real
  but empty turn); the FE then hits "session wasn't recoverable (no deliverable …
  after 2 attempts)"; the Lead-first escalation fires ("Use a conventional default
  stack … decide yourself, do not wait"); FE still produces nothing and a
  `question.updated` (`qst_…`) + `notification` "needs your guidance" is raised →
  `userQuestionsRaised=1`. This is the exact original no-code stall, re-exposed.
- **Secondary factor is real too:** builders dispatch before design settles and only
  pause for `ATEAM_DESIGN_WAIT_MS ?? 45_000` (orchestrator ~2812), and only for
  contract streams with an architect present — consistent with the findings note.
- **AC-H is not over-claimed:** it is only credited because the harness demonstrably
  distinguishes pass from fail (the self-tests exercise the PASS/true-paths that the
  fake adapter cannot), and it isolated/bounded two real runs without touching the
  cohort repo. The docs are careful to say AC-H VERIFIED ≠ AC4/AC5 pass.

## Per-AC reconciliation (re-derived independently)

| AC | Verdict | Proving artifact (re-derived) |
|----|---------|-------------------------------|
| **AC4** — greenfield Frontend decides under uncertainty & produces real code (no clarifying-question stall) | **NOT-VERIFIED (live)** | `run1/run2 outcome.json` `frontendProducedCode=false` + `userQuestionsRaised=1`; `run1/events.jsonl` shows FE empty turns → "no deliverable after 2 attempts" → Lead escalation → user question. Product defect (PR #4), not harness. |
| **AC5** — Architect states a concrete stack & design persisted before builders act | **NOT-VERIFIED (live)** | `outcome.json` `designPersisted=false`/`designStatedStack=false`; architect `chat.message content:""`; `orchestrator.ts` `if (!text) return` before `setEpicDesign` → `epic_designs` empty. Product defect (PR #4). |
| **AC-H** — live smoke repeatable, opt-in (real w/o `--fake`), bounded, isolated, never writes cohort repo, scores AC4/AC5 correctly | **VERIFIED** | 7/7 `harness.selftest.mjs`; `run.mjs` scratch port/DB/worktree + `makeGreenfieldRepo` under `h.scratch/target`; read-only sqlite; backward-compatible `until(snap,h)`; `authIssue=false` both runs; two repeatable bounded runs. |

Prior status AC4/AC5 = "VERIFIED-WITH-LIMITATIONS" (fake adapter only). This task
correctly MOVES them to **NOT-VERIFIED (live)** with a pinpointed root cause — an
honest downgrade, not a regression introduced by this task.

## NOT-VERIFIED honesty note
The two NOT-VERIFIED verdicts are honestly and correctly represented. They are
attributed to previously-shipped product code (empty-turn no-op in `designThenEnrich`
+ fake-tuned 45s timeouts), not to the harness, and are reopened as concrete
follow-ups (#1 retry/fallback on empty design turn; #2 gate builder dispatch on
design-settled; #3 adapter-aware timeouts). The evidence (identical two-run signal,
code guard, event trace) fully supports the claim. Nothing is over- or under-claimed.

## Metrics / mutation note
- Coverage of new scoring logic is via 7 real-path self-tests (temp git + sqlite),
  not %-coverage or mutation score. Mutation testing was skipped (UI/infra project) —
  acceptable here; the true-path assertions guard the PASS branches that matter.
- Minor gap (F4): the branch-based clone-GC attribution fallback is unasserted;
  low risk (safe-degrading), worth a follow-up test.

## Overall: APPROVE
The verification apparatus is trustworthy and the recorded outcome is honest:
AC-H VERIFIED; AC4/AC5 NOT-VERIFIED (live) with a substantiated product root cause;
`src/**` untouched; lint + typecheck + 7/7 self-tests green.

---
## Parent dispositions — APPROVE (verification apparatus sound + honest)
- F4 (branch-GC attribution path unasserted): ACCEPTED — safe-degrading fallback; primary clone attribution is self-tested.
- F5 (streamsWithCode counts test files): ACCEPTED — cosmetic; frontendProducedCode itself excludes test files (asserted).
- AC verdicts stand: AC-H VERIFIED; AC4/AC5 NOT-VERIFIED (live) — product defects in design-first (PR #4), reopened as follow-ups in report.html §8. Quality gate: 343 pass / 1 skip / 1 known Windows GC flake (passes in isolation 13/13); lint+typecheck clean; probe pass; src/** untouched.
