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

/** Well-known repo-level agent/contributor instruction files, in priority order. */
const INSTRUCTION_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.cursorrules',
  '.windsurfrules',
  '.github/copilot-instructions.md',
  'CONVENTIONS.md',
];
/** Directories whose markdown files are per-scope instruction rules. */
const INSTRUCTION_DIRS = ['.cursor/rules', '.github/instructions'];
/**
 * Basenames treated as per-directory (nested) instruction files. A monorepo often
 * ships package-scoped rules (e.g. `packages/core/AGENTS.md`) that MUST be honored
 * for work in that subtree, so we walk beyond the repo root for these.
 */
const NESTED_INSTRUCTION_BASENAMES = new Set([
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  'CONVENTIONS.md',
  '.cursorrules',
  '.windsurfrules',
]);
/** Directories never worth walking for nested instructions (heavy or generated). */
const NESTED_IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  'vendor',
  'tmp',
  'target',
  'bin',
  'obj',
]);
const MAX_NESTED_DEPTH = 6;
const MAX_NESTED_FILES = 60;
const MAX_PER_FILE = 6000;
const MAX_TOTAL = 16000;

export interface RepoInstructionFile {
  rel: string;
  content: string;
  /** True when this file's body was cut to fit MAX_PER_FILE. */
  truncated?: boolean;
}
export interface RepoInstructionsResult {
  files: RepoInstructionFile[];
  /** rels whose content was truncated to fit MAX_PER_FILE. */
  truncatedFiles: string[];
  /** rels that were discovered but DROPPED because the MAX_TOTAL budget was exhausted. */
  droppedFiles: string[];
}

/**
 * Discover the repository's OWN agent/contributor instructions (AGENTS.md,
 * CLAUDE.md, Copilot/Cursor/Windsurf rules, …) so every agent honors the
 * conventions, commands, and constraints the repo defines — including
 * package-scoped rules nested under subdirectories (monorepos). Read from the
 * agent's actual working directory (the per-epic clone for epic work), so branch
 * clones pick these up too. Size-capped so a large doc can't blow the prompt; when
 * the cap forces truncation/drops we report it so callers can surface a warning.
 */
export function collectRepoInstructions(cwd: string): RepoInstructionsResult {
  const files: RepoInstructionFile[] = [];
  const truncatedFiles: string[] = [];
  const droppedFiles: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  const push = (rel: string): void => {
    const norm = rel.replace(/\\/g, '/');
    if (seen.has(norm)) return;
    try {
      const abs = path.join(cwd, rel);
      if (!fs.statSync(abs).isFile()) return;
      let content = fs.readFileSync(abs, 'utf8').trim();
      if (!content) return;
      // Budget already spent: record the drop so it isn't lost silently.
      if (total >= MAX_TOTAL) {
        seen.add(norm);
        droppedFiles.push(norm);
        return;
      }
      let truncated = false;
      if (content.length > MAX_PER_FILE) {
        content = `${content.slice(0, MAX_PER_FILE)}\n… (truncated)`;
        truncated = true;
        truncatedFiles.push(norm);
      }
      seen.add(norm);
      total += content.length;
      files.push(truncated ? { rel: norm, content, truncated } : { rel: norm, content });
    } catch {
      /* missing/unreadable — skip */
    }
  };
  // 1) Root well-known files (highest priority).
  for (const f of INSTRUCTION_FILES) push(f);
  // 2) Root instruction-rule directories.
  for (const dir of INSTRUCTION_DIRS) {
    try {
      if (!fs.statSync(path.join(cwd, dir)).isDirectory()) continue;
      for (const f of fs.readdirSync(path.join(cwd, dir)).sort()) {
        if (/\.(md|mdc)$/i.test(f)) push(path.join(dir, f));
      }
    } catch {
      /* no such dir — skip */
    }
  }
  // 3) Nested per-directory instruction files (monorepo package rules), walked
  //    breadth-first, deterministic order, bounded by depth/count/ignore-list.
  let nestedCount = 0;
  const queue: Array<{ rel: string; depth: number }> = [{ rel: '', depth: 0 }];
  while (queue.length > 0) {
    const { rel, depth } = queue.shift()!;
    if (depth > MAX_NESTED_DEPTH || nestedCount >= MAX_NESTED_FILES || total >= MAX_TOTAL) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(cwd, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || NESTED_IGNORE_DIRS.has(e.name)) continue;
        if (depth + 1 <= MAX_NESTED_DEPTH) queue.push({ rel: childRel, depth: depth + 1 });
      } else if (depth > 0 && NESTED_INSTRUCTION_BASENAMES.has(e.name)) {
        // depth>0 so root files (already handled with correct priority) aren't re-added.
        if (nestedCount >= MAX_NESTED_FILES) break;
        nestedCount += 1;
        push(childRel);
      }
    }
  }
  return { files, truncatedFiles, droppedFiles };
}

/** Back-compat convenience: just the discovered instruction files. */
export function discoverRepoInstructions(cwd: string): RepoInstructionFile[] {
  return collectRepoInstructions(cwd).files;
}

export interface GroundingInput {
  project: Project;
  self: Agent;
  team: Agent[];
  /**
   * The agent's ACTUAL working directory for this session. For epic work this is
   * the isolated git worktree, NOT the project checkout, so file paths must
   * resolve here or the changes never land on the epic branch.
   */
  workingDirectory?: string;
}

export function buildSystemPrompt({
  project,
  self,
  team,
  workingDirectory,
}: GroundingInput): string {
  const cwd = workingDirectory ?? project.repoDir;
  const onWorktree = cwd !== project.repoDir;
  const stack = detectStack(cwd);
  const entries = topLevel(cwd);
  const roster = team
    .map((a) => {
      const me = a.id === self.id ? '  ← YOU' : '';
      const lead = a.kind === 'lead' ? ' [Team Lead]' : '';
      return `- \`${a.name}\` (${a.displayName})${lead}: ${a.description}${me}`;
    })
    .join('\n');

  const isLead = self.kind === 'lead';
  const tools = self.tools; // null => full tool access (e.g. the Lead)
  // Capability-based so custom agents get the right bar too: an agent that can run
  // shell is a true code builder; one that can only write is a spec/doc author.
  const canRunCode = !isLead && (tools === null || tools.includes('bash'));
  const canWrite = !isLead && (tools === null || tools.some((t) => t === 'write' || t === 'edit'));
  const deliveryBlock = canRunCode
    ? `\n\n# Delivery standard (MANDATORY for every build task)\n` +
      `Your task is ONE slice of a larger epic; deliver it to a principal-engineer bar:\n` +
      `- **Study first.** Read the relevant existing code, tests, and conventions before changing ` +
      `anything. Reuse the project's patterns, structure, and design tokens - never reinvent what ` +
      `already exists.\n` +
      `- **Integrate, don't collide.** Honor the interfaces, types, and contracts other streams ` +
      `depend on, and build on what sibling tasks already landed. Keep your changes cohesive and ` +
      `scoped to your task; don't duplicate or break others' work.\n` +
      `- **Finish it - no stubs.** Ship a COMPLETE, working implementation: no TODOs, placeholders, ` +
      `commented-out code, or mock/hard-coded values standing in for real logic. If the task is ` +
      `large, decompose it yourself and keep going until every part actually works end to end.\n` +
      `- **Prove it works.** Add unit AND integration tests for the behavior you changed. Discover ` +
      `the project's real build/lint/test commands (package.json scripts, Makefile, CI config, or ` +
      `the repo instructions) and RUN them; leave the build green (typecheck, lint, tests) before ` +
      `handing off. Never claim "done" on a red or unverified build - if you can't get it green, ` +
      `report the exact failure instead.\n` +
      `- **Report with evidence.** In your completion note, cite the exact files you changed and ` +
      `the commands you ran with their pass/fail output.`
    : canWrite
      ? `\n\n# Delivery standard\n` +
        `Produce COMPLETE, accurate deliverables the team can act on directly: cover every relevant ` +
        `state, flow, and edge case, ground them in the ACTUAL codebase (read before you write), and ` +
        `keep them consistent with the code and with what sibling streams produced. No placeholders ` +
        `or half-specified sections.`
      : '';

  const { files: repoInstructions, truncatedFiles, droppedFiles } = collectRepoInstructions(cwd);
  const capNote =
    truncatedFiles.length || droppedFiles.length
      ? `\n\n> ⚠ Some instruction content exceeded the context budget:` +
        (truncatedFiles.length ? ` truncated ${truncatedFiles.join(', ')}.` : '') +
        (droppedFiles.length ? ` dropped ${droppedFiles.join(', ')}.` : '') +
        ` If a rule you need is cut, open the file directly with your tools.`
      : '';
  const instructionsBlock = repoInstructions.length
    ? `\n\n# Repository instructions (MANDATORY — honor these)\n` +
      `This repository ships its OWN agent/contributor instructions. You **MUST read and follow ` +
      `them**; they take precedence over generic defaults wherever they conflict. Obey their ` +
      `conventions, commands, constraints, and definition of done exactly.\n\n` +
      repoInstructions.map((f) => `## ${f.rel}\n${f.content}`).join('\n\n') +
      capNote
    : '';

  return `# Environment
You are \`${self.name}\` (${self.displayName}), an autonomous AI agent on **Cohort** — a team of
specialist agents that collaborate to deliver software. You have your OWN Copilot session with a
workspace scoped to your working directory: you can read files, and (when permitted) write files and
run shell commands there. You are ${isLead ? 'the **Team Lead**' : `the **${self.displayName}**`}.

# Project
- Name: ${project.name}
- **Working directory (all your file paths resolve here): ${cwd}**
- Detected stack: ${stack.length ? stack.join(', ') : 'unknown (inspect the repo to learn it)'}
- Top-level entries: ${entries.length ? entries.join(', ') : '(empty repo)'}

> IMPORTANT: create and edit files INSIDE your working directory using RELATIVE paths (e.g.
> \`src/app.js\`). Your file edits and your shell commands share this exact directory.${
    onWorktree
      ? ' You are on an ISOLATED git worktree/branch: if you write to any other path (including the\n> main project checkout) your work is lost and never reaches the pull request. Never `cd` away from here.'
      : ''
  }

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
- You **orchestrate; you do NOT implement**. Never write or edit code/files yourself and never run
  build/shell commands to produce deliverables — you have no write access. Delegate every code change
  to the right specialist, who works in an isolated per-epic checkout. Your job is planning,
  assignment, coordination, review, and merge.
- You **cannot run, start, build, test, or execute anything yourself** — you have only read tools.
  If the user asks you to run/start/verify something (e.g. "start the server", "is it up?", "run the
  tests"), do NOT claim you will do it. Either give the user the exact command to run themselves, or
  assign a specialist (e.g. QA) to do it in their checkout and report the result back — then answer
  the user with what you found. Always finish your turn with a direct reply to the user.
- Drive quality relentlessly: nothing is “done” until it meets the bar (correct, tested, reviewed,
  matching project conventions). Before merging, confirm the epic works end-to-end against its
  acceptance criteria — not just that each task is individually green. Send work back for iteration
  until it does, and keep the board and the user honestly up to date. You are the single throat to
  choke for this project's success.`
    : `- Do your specialist work to a principal-engineer standard: correct, tested, secure, and
  matching the project's existing conventions. Report progress succinctly.`
}
${instructionsBlock}${deliveryBlock}

# Your role
${self.prompt}`;
}
