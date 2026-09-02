# Cohort — Agent Catalog

Cohort ships with a **Team Lead** (the sole orchestrator you talk to) plus **12
specialist templates** you can add to any project. You can also create fully custom
agents. Source of truth: `src/server/agents/catalog.ts`.

Each specialist is a real, independent SDK session — grounded in the project, the
environment, and its teammates — not a prompt fragment of one model.

---

## Tool profiles

Templates ship with a scoped tool allow-list:

- **Read-only** — `view`, `grep`, `glob` (can inspect, cannot change files).
- **Builder** — `view`, `grep`, `glob`, `edit`, `write`, `bash` (can implement).
- Some read-only roles also get `write` for **specs** (not production code).

You can tighten or widen any agent's tools when adding or editing it. The Team Lead
has **all tools** (`tools: null`) but leads and decides rather than doing hands-on
implementation.

---

## Team Lead

| | |
| --- | --- |
| **Name** | `team-lead` |
| **Role** | The only agent the user talks to; owns every request end to end. |
| **Tools** | All |
| **Responsibilities** | Clarify (with the PM) → shape the approach (optional group brainstorm) → decompose the epic into stream-tagged tasks → assign for safe parallelism → hold the quality bar (green build + acceptance criteria) → coordinate PR, review, and merge → keep you informed. |

The Lead never hand-writes specialists' implementation, never manages the board via
raw DB/SQL/todo tools (the system materializes its decomposition onto the Kanban),
and escalates to the user only for decisions the team genuinely can't make.

---

## Specialists

| Template | Name | Tools | What it does |
| --- | --- | --- | --- |
| 🧭 **Product Manager** | `pm` | read-only | Converts ambiguous asks into a problem statement, target users, measurable outcomes, and **testable Given/When/Then acceptance criteria**. Prioritizes (MoSCoW), names what's deferred. Does not write code. |
| 📐 **Software Architect** | `architect` | read-only | Produces a concise technical **design before any code** (approach, components, interfaces, data/control flow, risks) and a dependency-ordered task breakdown by stream. Later reviews the PR against that design. No production code. |
| 🎨 **UX Designer** | `ux` | read-only + `write` | Information architecture, user flows, and **accessible UI specs** (WCAG 2.2 AA). Specifies every state (empty/loading/error/success). Writes specs, not production code. |
| 🖥️ **Frontend Engineer** | `frontend` | builder | Clean, accessible, responsive UI matching existing framework/tokens. **Unit + integration tests mandatory**, ≥80% coverage, green build before handoff. |
| ⚙️ **Backend Engineer** | `backend` | builder | Robust APIs/services with strict validation, explicit error handling, no secrets. **Unit + integration tests mandatory**, ≥80% coverage, green build. |
| 🧪 **QA Engineer** | `qa` | builder | The final quality gate. **Owns end-to-end testing** — detects the repo's E2E framework (or adds one), derives scenarios from acceptance criteria, and only signs off **after E2E tests actually run and pass**, with evidence. |
| 🚀 **DevOps Engineer** | `devops` | builder | Reproducible build/release, CI, and deployment config using existing tooling. Secrets out of source, idempotent steps, fail-fast diagnostics. |
| 📝 **Docs Writer** | `docs` | read-only + `write`/`edit` | Accurate, concise docs a newcomer can follow, with examples that actually execute; kept in sync with the code. |
| 🔍 **Researcher** | `researcher` | read-only | Explores the codebase and cited external sources, separates verified facts from assumptions, summarizes with `file:line`/URL references. Never modifies files. |
| 🔬 **Code Reviewer** | `reviewer` | read-only | Reviews diffs for correctness, security, performance, readability, and test quality. Findings ranked blocker/major/minor, each anchored to a line with a suggested fix. Approves only when correct, tested, and safe. |
| 🛡️ **Security Auditor** | `security` | read-only | Hunts OWASP Top 10 issues, secrets, and insecure defaults. Ranks findings by severity with a concrete exploit scenario and remediation. Does not modify files. |
| 🗄️ **Data Engineer** | `data` | builder | Normalized schemas, safe **reversible migrations (with rollback)**, well-indexed queries, integrity constraints, and backfill-risk callouts. |

---

## Custom agents

Create your own from the **Agents** page. You control:

- **Name** (machine name, unique per project) and **display name**
- **Description** and **system prompt** (persona)
- **Tool allow-list** (or all tools)
- **Skills** to preload (discovered `SKILL.md` files)
- **Model** (per agent; defaults to the project default / `auto`)
- **Emoji** and **color** for the board and activity feed

---

## How the team collaborates

- The **Lead** decomposes each request and assigns stream-tagged tasks for safe
  parallelism.
- Specialists work **in parallel** in isolated worktrees, keep living scratchpads,
  and move their board cards across columns.
- They talk for real: **group brainstorm threads**, escalation to the Lead, and
  multi-author chat.
- Builders honor the Architect's shared interfaces; the **Reviewer**/**Security**/
  **QA** roles gate quality before merge.

See [USER-GUIDE](./USER-GUIDE.md) for how to drive them and
[ARCHITECTURE](./ARCHITECTURE.md) for how sessions and gates work.
