# Cohort — User Guide

This guide walks through everyday use of Cohort: creating a project, giving the
team work, watching it get done, and reviewing and merging the result. For
install/run steps see the [README](../README.md); for internals see
[ARCHITECTURE](./ARCHITECTURE.md).

---

## 1. Concepts at a glance

| Concept | What it is |
| --- | --- |
| **Project** | A pointer to a locally checked-out git repo the team works in. Run many in parallel. |
| **Team Lead** | The single orchestrating agent you talk to. Owns every request end to end. |
| **Specialist** | A principal-level agent (PM, Architect, Frontend, Backend, QA, …) the Lead assigns work to. |
| **Epic** | One user request. The Lead decomposes it into tasks and drives it to a merge. |
| **Task** | A unit of an epic, tagged by *stream* (frontend/backend/qa/…) and assigned to one agent. |
| **Board** | The project Kanban: `backlog → todo → in_progress → review → done`. |
| **Worktree** | An isolated git checkout per epic (branch `ateam/epic-<id>`), kept outside your repo. |
| **Pull request** | Opened when an epic's tasks are done; peer-reviewed and iterated before a real `git merge --no-ff`. |
| **Scratchpad** | Each agent's living plan + timestamped notes you can watch. |
| **Skill** | A discovered `SKILL.md` you can preload into an agent's context. |

---

## 2. Create a project

1. Open the app (`http://localhost:5319` in dev, or `http://localhost:4319` for a
   production build).
2. On the **Projects** home, click **New Project**.
3. Fill in:
   - **Name** — anything memorable.
   - **Repository directory** — an absolute path to a *locally checked-out git
     repo*. Use the directory picker; if the folder doesn't exist yet you can opt
     to create it.
   - **Default model** — `auto` (always available) or a specific model enabled on
     your Copilot account (e.g. `claude-sonnet-5`, `gpt-5.5`). Overridable per agent.
   - **Approval mode** — `auto-workspace` (agents run tools freely inside the repo,
     writes outside are blocked) or `manual` (you approve tool actions).
4. Create it. The project starts with a **Team Lead** already on the roster.

> The repo should be a normal git working copy. Cohort never touches
> `main`/`master` directly — all work happens on per-epic branches in isolated
> worktrees and only lands via an explicit merge.

---

## 3. Build your team

Open the **Agents** page for the project.

- **Add from catalog** — pick from the 12 shipped specialist templates (see
  [AGENTS](./AGENTS.md)). Each comes with a tuned persona, a sensible tool
  allow-list, an emoji/color, and suggested skills.
- **Create a custom agent** — set name, description, system prompt, tool
  allow-list, **skills** to preload, and a **per-agent model**.
- **Edit / remove** any specialist at any time. The Team Lead can't be removed.

You don't have to hand-pick a full team — the Lead works with whoever is on the
roster and will tell you if it wants a discipline you haven't added.

---

## 4. Give the team work (Chat)

The **Chat** page is your single channel to the whole team — you only ever talk
to the Team Lead.

Type a request in plain language, e.g.:

> "Add a dark-mode toggle to the settings page, persist the choice, and cover it
> with tests."

What happens next:

1. **Clarify** — the Lead consults the Product Manager and asks you only the few
   questions that would actually change the plan, each with a recommended default.
   Reply "go with your recommendation" to move fast.
2. **Plan** — it may convene a short **group brainstorm** with the relevant
   specialists, then decomposes the request into an **epic** with stream-tagged
   tasks and dependencies. These appear on the **Board**.
3. **Execute** — tasks are assigned for safe parallelism. Each specialist picks up
   its task, works in an isolated worktree, and moves the card across the board.
4. **Review & merge** — when the tasks are done the Lead opens a **PR**, assigns an
   independent reviewer, iterates to the quality bar, then merges.

Throughout, the Lead posts brief status updates back into Chat.

---

## 5. Watch the work

- **Dashboard** — project overview: agents, active epics, recent activity, usage.
- **Board** — the Kanban. You can also create work items yourself (assign one to an
  agent and it auto-picks it up), set **priority**, add **dependencies**, and
  **schedule** an item for later or make it **recurring** (hourly/daily/weekly).
- **Agents → (an agent)** — that specialist's live **scratchpad** (plan + notes),
  personal task list, and event stream.
- **Activity** — a real-time feed of every agent's messages, reasoning, tool calls,
  and sub-agent lifecycle, streamed over WebSocket.
- **Git** — per-epic branches, worktrees, commits, and changed files; the review
  and merge state live here too.
- **Recordings** — if enabled in Settings, a full transcript of every agent turn
  (prompt, response, reasoning, tool steps, tokens), exportable as JSONL or Markdown.
- **Notifications** — plan/progress/PR/review/merge/question events, each linking to
  the relevant page.

---

## 6. Answer escalations

When a specialist hits a decision only you can make, it escalates to the Team
Lead, which either resolves it or **asks you**. Pending questions surface in
**Notifications** (and inline in Chat). Answer — optionally by picking one of the
offered choices — and the answer flows back and work resumes.

---

## 7. Review pull requests

When an epic's work is ready, the Lead opens a PR (visible on the **Git** page):

- An **independent reviewer** agent inspects the diff and files comments ranked by
  severity, each routed to the responsible stream.
- The Lead assigns **fix tasks** for open comments and iterates. After a capped
  number of review rounds with still-open comments, the epic **parks and asks you**
  (merge anyway / keep working) rather than silently merging past them — this cap is
  `ATEAM_MAX_REVIEW_ITER` (default 3).
- Once approved and all objective **gates pass** (build, tests, acceptance probe),
  the branch merges with a real `git merge --no-ff` onto the epic's base.

You can read the diff, commits, and changed files for any epic on the Git page.

---

## 8. Quality gates (what "done" means)

Cohort enforces "done" as observable behavior, not vibes. Before an epic can
merge:

- **Build gate** — the code still compiles (`typecheck` > `build` > `compile`, or a
  `buildCommand` you set).
- **Test gate** — the project's tests pass (auto-detected, or a `testCommand` you set).
- **Acceptance probe** — a deterministic, spec-derived check independent of the
  agents' own unit tests: a `acceptanceCommand`, else a committed
  `.ateam/acceptance.mjs`, else an LLM acceptance judge.
- **Peer review** — an independent reviewer must approve (or you override).

These are configurable per project in **Settings** (see
[CONFIGURATION](./CONFIGURATION.md)).

---

## 9. Control the team

- **Pause / Resume** (per project) — pause stops new agent-driven work from
  starting; in-flight turns finish. Resume picks work back up.
- **Manual approval mode** — switch a project to approve tool actions yourself
  instead of auto-running inside the workspace.
- **Session recording** — toggle in Settings to capture full turn transcripts.
- **Skills** — Cohort auto-discovers `SKILL.md` skills from your home roots and each
  project; select which ones each agent preloads.

---

## 10. Tips

- Start with a small, well-scoped request to see the full epic → PR → merge loop end
  to end before handing over something large.
- Give the team a repo with a working **test command** — the QA gate is only as
  strong as the tests it can run.
- Use **`auto`** as the default model unless you have a reason to pin one; pin a
  stronger model per agent for the Architect/Reviewer if you want deeper reviews.
- Set `ATEAM_FAKE_SDK=1` to explore the whole UI offline with a deterministic fake
  runtime (no Copilot calls, no tokens spent).

See also: [CONFIGURATION](./CONFIGURATION.md) · [ARCHITECTURE](./ARCHITECTURE.md) ·
[AGENTS](./AGENTS.md) · [DEVELOPMENT](./DEVELOPMENT.md).
