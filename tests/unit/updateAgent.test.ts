import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/server/db/database.js';
import { Store } from '../../src/server/db/store.js';
import type { Agent, Project } from '../../src/shared/index.js';

let store: Store;
let project: Project;

function seedAgent(): Agent {
  return store.createAgent({
    projectId: project.id,
    kind: 'specialist',
    catalogId: 'frontend-engineer',
    name: 'frontend-engineer',
    displayName: 'Frontend Engineer',
    description: 'Builds UI',
    prompt: 'You build UIs.',
    tools: null,
    skills: [],
    model: 'auto',
    emoji: '🤖',
    color: '#89b4fa',
    status: 'idle',
  });
}

beforeEach(() => {
  store = new Store(openDatabase(':memory:'));
  project = store.createProject({
    name: 'P',
    repoDir: process.cwd(),
    settings: { defaultModel: 'auto', approvalMode: 'auto-workspace', extraSkillRoots: [] },
  });
});

describe('store.updateAgent', () => {
  it('applies a partial edit without clobbering unspecified fields (emoji/color/tools)', () => {
    const agent = seedAgent();
    // Mirrors the editor: only these fields are sent; emoji/color/tools are undefined.
    const updated = store.updateAgent(agent.id, {
      displayName: 'FE Renamed',
      description: 'Now with a11y',
      prompt: 'Updated persona.',
      model: 'gpt-5',
      skills: ['a11y'],
      emoji: undefined,
      color: undefined,
      tools: undefined,
    });
    expect(updated).toBeDefined();
    expect(updated!.displayName).toBe('FE Renamed');
    expect(updated!.description).toBe('Now with a11y');
    expect(updated!.model).toBe('gpt-5');
    expect(updated!.skills).toEqual(['a11y']);
    // Preserved from the original — must NOT become null/undefined.
    expect(updated!.emoji).toBe('🤖');
    expect(updated!.color).toBe('#89b4fa');
  });

  it('does not throw on a partial patch (regression: undefined NOT NULL binding)', () => {
    const agent = seedAgent();
    expect(() => store.updateAgent(agent.id, { displayName: 'X' })).not.toThrow();
    expect(store.getAgent(agent.id)!.displayName).toBe('X');
  });

  it('returns undefined for an unknown agent', () => {
    expect(store.updateAgent('nope', { displayName: 'X' })).toBeUndefined();
  });
});
