# Live-run findings — design-first, real Copilot adapter

Two live runs (real `copilot-sdk` adapter, model `auto`, isolated scratch), driven
by the committed `design-first` eval scenario. Evidence: `run1/`, `run2/`
(report.md, outcome.json, events.jsonl).

| Run | Design timeout | Window | epicsTotal | designPersisted | frontendProducedCode | userQuestionsRaised | completed |
|-----|----------------|--------|-----------|-----------------|----------------------|---------------------|-----------|
| 1 | 45s (default) | 25 min | 1 | **false** | **false** | 1 | no (timeout) |
| 2 | 240s (raised) | 36 min | 1 | **false** | **false** | 1 | no (timeout) |

## What actually happened (server-authoritative)
1. The epic was created and the **template floor** dispatched frontend + qa tasks (never-strand invariant held — AC3 confirmed live).
2. The **Architect ran a design turn** (agt_VEkyl…: status working→idle, 1 model call / usage.updated) but emitted a **0-length chat.message** — a tool-only / empty turn.
3. `designThenEnrich` guards on `if (!text) return` (orchestrator.ts ~1281), so an empty turn is a **silent no-op**: `epic_designs` stayed **empty**, no `<!--design-acceptance-->` enrichment.
4. With **no persisted design/stack to anchor to**, the greenfield **Frontend Engineer stalled** — "session wasn't recoverable (no deliverable … after 2 attempts)".
5. The **Lead-first escalation** (shipped Feature B) fired — "@Frontend Engineer you're blocked … Use a conventional default stack and ship the smallest working slice … decide yourself, do not wait" — but the FE **still** could not produce code and raised a **user question** ("Frontend Engineer could not produce deliverable changes even after a fresh session, and needs your guidance").

## Root cause
**The design-first flow collapses when the real Architect turn returns empty text.**
`this.actor(designer).ask(...)` can resolve to `''` (a tool-only turn — the real
adapter's `finish()` yields empty when no `assistant.message` text is produced).
`designThenEnrich` treats empty as "no-op, keep template" — correct for
never-stranding, but it means **no design is persisted**, so the greenfield
Frontend never gets the stack/spec the AC4 persona fix relies on, and the
original no-code stall re-appears. Raising the design timeout (run 2) did not
help because the turn returned empty, not slow.

Contributing factors (secondary):
- Builders are **dispatched before** the design completes and only pause on
  `awaitEpicDesign` for `ATEAM_DESIGN_WAIT_MS` (default **45s**, orchestrator ~2812);
  a real design turn easily exceeds that, so a builder can start design-less even
  when a design would eventually persist.
- `ATEAM_DESIGN_TIMEOUT_MS` default **45s** is tuned for the fake/tests, not real
  LLM latency.

## Verdicts (this task)
- **AC-H (the live smoke harness): VERIFIED.** It boots the real adapter against a
  greenfield repo, is bounded/isolated/opt-in, and **correctly, repeatably
  measured a true-negative** with a pinpointed root cause. Deterministic scoring
  proven by 7/7 self-tests. `authIssue === false` both runs.
- **AC4 (Frontend decides & produces code, no stall): NOT-VERIFIED live.** The FE
  stalled and escalated to the user in both runs. The persona "decide under
  uncertainty" clause did not prevent it; the reactive Lead escalation did not
  rescue it within the window.
- **AC5 (Architect states a stack; design persisted before builders): NOT-VERIFIED
  live.** No design was ever persisted (`epic_designs` empty) because the Architect
  turn returned empty.

These NOT-VERIFIEDs are **product defects in the previously-shipped design-first
feature (PR #4)**, surfaced by this task's harness — not defects in the harness.
They reopen that feature's implementation as concrete follow-ups (below).

## Follow-ups (reopen design-first implementation)
1. **Empty/tool-only design turn must not silently collapse design-first.** If the
   Architect returns empty, retry once with a text-only instruction, and/or fall
   back to the Lead as designer, before giving up. (root cause; smallest fix)
2. **Don't dispatch builders design-less on real latency.** Make the builder
   `awaitEpicDesign` wait cover the design turn (align `ATEAM_DESIGN_WAIT_MS` with
   `ATEAM_DESIGN_TIMEOUT_MS`, or gate dispatch on design-settled with the template
   still as the timeout floor).
3. **Raise the real-LLM default timeouts** (or make them adapter-aware); 45s is a
   fake-tuned default.

## Exact reproduction (finishing command for a human)
```
# from the cohort repo, signed in to copilot:
ATEAM_DESIGN_TIMEOUT_MS=240000 node evals/run.mjs design-first --port=4620 --timeout=36
# inspect: evals/reports/design-first-*.{md,json}; epic_designs stays empty,
# frontendProducedCode=false, a user question is raised.
# After fix #1 lands, this scenario's AC4/AC5 checks should flip to green.
```
