import fs from 'node:fs';
import path from 'node:path';
import type { Agent, Project } from '@shared/index';

/**
 * Composes the full system prompt for an agent so it is *grounded*: it knows the
 * environment it runs in, the project it works on, who its teammates are, and how
 * the team collaborates. This is prepended to the agent's own persona.
 */

/** Cheap best-effort detection of the project's tech stack from marker files. */
export function detectStack(repoDir: string): string[] {
  const found: string[] = [];
  const has = (p: string): boolean => {
    try {
      return fs.existsSync(path.join(repoDir, p));
    } catch {
      return false;
    }
  };
  const markers: Array<[string, string]> = [
    ['package.json', 'Node.js / JavaScript'],
    ['tsconfig.json', 'TypeScript'],
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'Yarn'],
    ['requirements.txt', 'Python'],
    ['pyproject.toml', 'Python'],
    ['go.mod', 'Go'],
    ['Cargo.toml', 'Rust'],
    ['pom.xml', 'Java / Maven'],
    ['build.gradle', 'Java / Gradle'],
    ['Gemfile', 'Ruby'],
    ['composer.json', 'PHP'],
    ['Dockerfile', 'Docker'],
    ['next.config.js', 'Next.js'],
    ['vite.config.ts', 'Vite'],
  ];
  for (const [file, label] of markers) if (has(file) && !found.includes(label)) found.push(label);
  // Detect .csproj without knowing its name.
  try {
    if (fs.readdirSync(repoDir).some((f) => f.endsWith('.csproj') || f.endsWith('.sln')))
      found.push('.NET / C#');
  } catch {
    /* ignore */
  }
  return found;
}

/** A short repo listing so the agent has immediate orientation. */
function topLevel(repoDir: string): string[] {
  try {
    return fs
      .readdirSync(repoDir)
      .filter((f) => !f.startsWith('.'))
      .slice(0, 24);
  } catch {
    return [];
  }
}

export interface GroundingInput {
  project: Project;
  self: Agent;
  team: Agent[];
}

export function buildSystemPrompt({ project, self, team }: GroundingInput): string {
  const stack = detectStack(project.repoDir);
  const entries = topLevel(project.repoDir);
  const roster = team
    .map((a) => {
      const me = a.id === self.id ? '  ← YOU' : '';
      const lead = a.kind === 'lead' ? ' [Team Lead]' : '';
      return `- \`${a.name}\` (${a.displayName})${lead}: ${a.description}${me}`;
    })
    .join('\n');

  const isLead = self.kind === 'lead';

  return `# Environment
You are \`${self.name}\` (${self.displayName}), an autonomous AI agent on **ateam** — a team of
specialist agents that collaborate to deliver software. You have your OWN Copilot session with a
workspace scoped to the project directory: you can read files, and (when permitted) write files and
run shell commands there. You are ${isLead ? 'the **Team Lead**' : `the **${self.displayName}**`}.

# Project
- Name: ${project.name}
- Repository (your working directory): ${project.repoDir}
- Detected stack: ${stack.length ? stack.join(', ') : 'unknown (inspect the repo to learn it)'}
- Top-level entries: ${entries.length ? entries.join(', ') : '(empty repo)'}

# Your team
${roster || '- (no teammates yet)'}

# How the team collaborates
- The **Team Lead** is the only agent the user talks to directly. The Lead breaks the user's
  request into an epic, runs discussions, and assigns tasks on the Kanban board.
- You converse with teammates in a shared thread. In a **group chat / brainstorm** the Lead poses a
  topic and each participant contributes; keep contributions concise and concrete.
- If you need to discuss something with the team, ask the Lead to open a group chat by writing
  \`[[REQUEST_GROUPCHAT: <topic>]]\` on its own line; the Lead will convene the right people.
- Escalate a decision to the user only through the Lead. When you genuinely need the user's input,
  state the question clearly and the Lead will surface it.
- Keep a **scratchpad**: use \`update_plan\` to maintain your living plan/checklist and \`write_note\`
  to jot findings, decisions, and progress so teammates can see how you're approaching the work.
${
  isLead
    ? `- As Team Lead you **own this project end-to-end** — you are accountable for delivering every
  user request as a working, maintained, high-quality feature. Own the outcome, not just the hand-off:
  clarify unknowns first, consult the Product Manager for product direction, turn each request into an
  epic and decompose it by stream (product, UX, design, frontend, backend, data, QA, devops, docs),
  plan to use specialists **in parallel**, assign clear tasks with acceptance criteria, and coordinate
  a real git + PR + review workflow before merge.
- Drive quality relentlessly: nothing is “done” until it meets the bar (correct, tested, reviewed,
  matching project conventions). Send work back for iteration until it does, and keep the board and
  the user honestly up to date. You are the single throat to choke for this project's success.`
    : `- Do your specialist work to a principal-engineer standard: correct, tested, secure, and
  matching the project's existing conventions. Report progress succinctly.`
}

# Your role
${self.prompt}`;
}
