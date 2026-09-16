# Research — Lead-first escalation, @mention wake, and the Frontend "no code" bug

Slug: `lead-escalation-mention` · Repo: cohort · Base: `main`

## Requirement (from the user + screenshot)
1. When an agent needs help, it should **invoke the Team Lead** to get unblocked — not park the run on a "NEEDS YOUR INPUT" prompt to the user.
2. Provide a way to **@-mention the Team Lead** in the conversation so the Lead "wakes up" and addresses the pending issue immediately.
3. **Diagnose why the Frontend Engineer produced no code** (screenshot: Snippet Vault; FE produced no deliverable even after a fresh session).

## Evidence base
The user's live run is on disk at `data/ateam.sqlite` (project `prj_kYSMCdIxFoFv` "Snippet Vault", repo `C:\code\projects\Snippet_Vault`). Queried read-only.

### Item 3 — root cause of the Frontend "no code" (CONFIRMED from run data)
- Across ALL specialists, **UX and Backend committed real code** (`10de7bec`, `bf7af006`, multi-minute turns), so the adapter/toolchain works. The **Frontend Engineer alone** produced *zero* file changes across ~10 attempts + 2 session restarts.
- The Frontend Engineer's own `agent_notes` explain why:
  - "**Checked & Found Empty:** Repository root: completely empty except .git and .gitignore. Git history: only one commit 'ateam: initial snapshot'."
  - Its self-authored sub-tasks are **questions, not work**: *"Tech stack (React? Vue? What CSS framework? TypeScript?)"*, *"Existing project patterns (if any)"*, *"The epic specification or design document for Snippet Vault"*.
- The frontend **task card** has only generic acceptance: *"deliver the Frontend Engineer slice … to a principal-engineer standard - correct, tested, and matching project conventions."* No tech stack, no design system, no concrete UI spec. `depends_on: []` (it did not even wait on backend/UX).

**Diagnosis:** On a greenfield/empty repo with no established framework, the Frontend Engineer has **nothing to "match"** and no tech-stack decision to build against, so it spends every turn gathering information and asking clarifying questions **to itself** instead of committing code. Backend/UX made assumptions and shipped; the UI slice is the one that structurally needs an up-front stack/design decision, and no one made it. The prompt even biases FE toward this: *"matches the project's existing framework, components, and design tokens — never introduce a new pattern when one already exists"* (`catalog.ts` frontend prompt) — on an empty repo that instruction has no anchor, so it stalls.

This converges with Item 1: the correct rescue is **the Team Lead makes the missing decision (tech stack + concrete UI spec) and re-drives**, not a dead-end "How should we proceed?" to the user.

## Current behavior (grounded in code)
- **Escalation to user** is `raiseQuestion(agentId, question, choices)` → creates a `Question`, notifies, and returns a Promise that only resolves via the escalation UI (`answer()`). 10 call sites in `orchestrator.ts` (no-code, build-fix, acceptance-fix, QA, integrate-fail, review budget, etc.).
- The **no-code path** (`orchestrator.ts` ~2600-2670): retry `MAX_ATTEMPTS=2` → on empty, **restart session once** → still empty → `setStatus('needs_input')` + `awaitingInput.add` + `notify('question', …)` + `raiseQuestion("… produced no code … How should we proceed?", ['Retry','Skip this task'])`. This is exactly the screenshot. There is **no Lead intervention step** between the restart and the user prompt.
- **Lead intervention already exists but is only stall-triggered**: `reviveBlockedAgent(agent)` (~2003) posts "@Agent you look blocked — I'm stepping in…" and asks the agent to state its blocker. It is invoked only from the manager tick's stall path (`troubleSignal` ≥ threshold, ~1975-1984), **not** from the no-code escalation. It also does not *make a decision* or re-drive — it just nudges.
- **Chat / Lead wake** (`chat(content, threadId)`, ~586): every user message appends, then **always** fires `actor(lead).ask(prompt)` and routes by keyword intent (`build|implement|fix|…` → `planEpic`; `brainstorm|discuss|…` → group chat). There is **no `@mention` parsing anywhere** (confirmed: no mention/@ handling in `orchestrator.ts` or `ChatPage.tsx`). A message like the screenshot's "are you looking into this issue?" gets a *conversational* reply but does **not** cause the Lead to take over the pending escalation / blocked task — the `raiseQuestion` promise stays parked on the user.

## Key files
- `src/server/orchestrator.ts` — `chat()` (586), `reviveBlockedAgent()` (2003), no-code path (~2560-2670), `raiseQuestion()` (4859), `answer()` (4892), `pokeLead()` (1424).
- `src/server/agents/catalog.ts` — specialist prompts (frontend stall bias).
- `src/web/pages/ChatPage.tsx` — chat input (556), send (571); no mention UI.
- `src/shared/domain.ts` — `Question` (402), `escalation` event type (177).

## Design implications (→ design.html)
- **Item 1+3:** Insert a **Lead-resolve step** before the user prompt in the blocker escalation: the Lead makes the missing decision (e.g., pick a tech stack + write a concrete spec into the task), posts it to the agent's thread, and re-queues the task. Only escalate to the user if the Lead-assisted re-drive **also** fails (true last resort).
- **Item 2:** Parse an `@team-lead` / `@lead` / `@<lead name>` mention in `chat()`. On mention, the Lead is "woken to act": beyond replying, it **takes over pending blockers** (answers/clears the parked `Question`s for this project by driving the Lead-resolve step + re-drive), so the user's prompt is resolved by the Lead instead of the human. Add a lightweight `@` affordance in the chat input.

## Assumptions (unattended; recorded for confirmation)
- A1: The Lead may **auto-decide** reversible technical choices (tech stack, file layout) to unblock, rather than asking the user — matching Cohort's "autonomous team" premise. Non-reversible/product choices still escalate to the user.
- A2: After one Lead-assisted re-drive that still yields no code, we **fall back to the existing user prompt** (Retry/Skip) — we do not loop the Lead forever.
- A3: `@mention` matches `@lead`, `@team-lead`, `@teamlead`, and `@<lead.displayName>` (case-insensitive), leading or inline.
- A4: Scope of Item 1 for this PR centers on the **no-code blocker path** (the one the user hit) with a reusable helper; the other `raiseQuestion` sites are left as-is but the helper is designed to be adoptable by them next.
