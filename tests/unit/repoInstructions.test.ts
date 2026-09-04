import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Agent, Project } from '../../src/shared/index.js';
import { discoverRepoInstructions, collectRepoInstructions, buildSystemPrompt } from '../../src/server/agents/context.js';

let repo: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-instr-'));
});
afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'a1',
    projectId: 'p1',
    kind: 'specialist',
    catalogId: 'frontend-engineer',
    name: 'frontend',
    displayName: 'Frontend Engineer',
    description: 'Builds UI',
    prompt: 'You build UI.',
    model: 'auto',
    tools: null,
    skills: [],
    status: 'idle',
    emoji: '🖥️',
    color: '#3b82f6',
    createdAt: '',
    updatedAt: '',
    ...over,
  } as Agent;
}

function project(): Project {
  return {
    id: 'p1',
    name: 'Demo',
    repoDir: repo,
    settings: { defaultModel: 'auto', approvalMode: 'auto-workspace', extraSkillRoots: [] },
    createdAt: '',
    updatedAt: '',
  };
}

describe('discoverRepoInstructions', () => {
  it('finds well-known instruction files at the repo root', () => {
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Rules\nUse tabs, not spaces.');
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), 'Always run npm test.');
    const found = discoverRepoInstructions(repo);
    const rels = found.map((f) => f.rel);
    expect(rels).toContain('AGENTS.md');
    expect(rels).toContain('CLAUDE.md');
    expect(found.find((f) => f.rel === 'AGENTS.md')?.content).toContain('Use tabs');
  });

  it('reads nested Copilot + Cursor rule locations', () => {
    fs.mkdirSync(path.join(repo, '.github'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.github', 'copilot-instructions.md'),
      'Prefer named exports.',
    );
    fs.mkdirSync(path.join(repo, '.cursor', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.cursor', 'rules', 'style.mdc'), 'No default exports.');
    const rels = discoverRepoInstructions(repo).map((f) => f.rel);
    expect(rels).toContain('.github/copilot-instructions.md');
    expect(rels).toContain('.cursor/rules/style.mdc');
  });

  it('truncates an oversized file and returns nothing for an empty repo', () => {
    expect(discoverRepoInstructions(repo)).toEqual([]);
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'x'.repeat(9000));
    const found = discoverRepoInstructions(repo);
    expect(found[0]?.content).toContain('(truncated)');
    expect(found[0]!.content.length).toBeLessThan(9000);
  });

  it('discovers nested per-package instruction files (monorepo AGENTS.md)', () => {
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'Root rules.');
    fs.mkdirSync(path.join(repo, 'packages', 'core'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'packages', 'core', 'AGENTS.md'), 'Core must stay pure.');
    const rels = discoverRepoInstructions(repo).map((f) => f.rel);
    expect(rels).toContain('AGENTS.md');
    expect(rels).toContain('packages/core/AGENTS.md');
  });

  it('does not descend into ignored dirs like node_modules/.git', () => {
    fs.mkdirSync(path.join(repo, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'node_modules', 'dep', 'AGENTS.md'), 'Should be ignored.');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'AGENTS.md'), 'Should be ignored.');
    const rels = discoverRepoInstructions(repo).map((f) => f.rel);
    expect(rels).not.toContain('node_modules/dep/AGENTS.md');
    expect(rels).not.toContain('.git/AGENTS.md');
  });

  it('reports truncated files so callers can warn', () => {
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'y'.repeat(9000));
    const res = collectRepoInstructions(repo);
    expect(res.truncatedFiles).toContain('AGENTS.md');
    expect(res.files[0]?.truncated).toBe(true);
  });
});

describe('buildSystemPrompt honors repo instructions', () => {
  it('injects a mandatory instructions section carrying the file content', () => {
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'Never touch the database directly.');
    const prompt = buildSystemPrompt({ project: project(), self: agent(), team: [agent()] });
    expect(prompt).toContain('Repository instructions (MANDATORY');
    expect(prompt).toContain('## AGENTS.md');
    expect(prompt).toContain('Never touch the database directly.');
  });

  it('omits the section entirely when the repo has no instruction files', () => {
    const prompt = buildSystemPrompt({ project: project(), self: agent(), team: [agent()] });
    expect(prompt).not.toContain('Repository instructions (MANDATORY');
  });

  it('injects nested package rules and warns when instructions are truncated', () => {
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'Root rules.');
    fs.mkdirSync(path.join(repo, 'packages', 'core'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'packages', 'core', 'AGENTS.md'), 'z'.repeat(9000));
    const prompt = buildSystemPrompt({ project: project(), self: agent(), team: [agent()] });
    expect(prompt).toContain('## packages/core/AGENTS.md');
    expect(prompt).toContain('exceeded the context budget');
    expect(prompt).toContain('packages/core/AGENTS.md');
  });
});

describe('buildSystemPrompt delivery standard (capability-scoped)', () => {
  it('gives a code builder (has bash) the full “no stubs, run the build green” standard', () => {
    const self = agent({ tools: ['view', 'grep', 'glob', 'edit', 'write', 'bash'] });
    const prompt = buildSystemPrompt({ project: project(), self, team: [self] });
    expect(prompt).toContain('Delivery standard (MANDATORY for every build task)');
    expect(prompt).toContain('no stubs');
    expect(prompt).toContain('leave the build green');
  });

  it('gives a spec/doc author (write only, no shell) the lighter deliverable standard', () => {
    const self = agent({
      catalogId: 'ux-designer',
      name: 'ux',
      displayName: 'UX Designer',
      tools: ['view', 'grep', 'glob', 'write'],
    });
    const prompt = buildSystemPrompt({ project: project(), self, team: [self] });
    expect(prompt).toContain('# Delivery standard');
    expect(prompt).not.toContain('MANDATORY for every build task');
    expect(prompt).toContain('No placeholders');
  });

  it('gives a read-only advisor no delivery block', () => {
    const self = agent({
      catalogId: 'code-reviewer',
      name: 'reviewer',
      displayName: 'Code Reviewer',
      tools: ['view', 'grep', 'glob'],
    });
    const prompt = buildSystemPrompt({ project: project(), self, team: [self] });
    expect(prompt).not.toContain('# Delivery standard');
  });
});
