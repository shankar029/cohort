import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase } from '../../src/server/db/database.js';
import { Store } from '../../src/server/db/store.js';
import type { Project } from '../../src/shared/index.js';

let store: Store;
let project: Project;

beforeEach(() => {
  store = new Store(openDatabase(':memory:'));
  project = store.createProject({
    name: 'P',
    repoDir: process.cwd(),
    settings: { defaultModel: 'auto', approvalMode: 'auto-workspace', extraSkillRoots: [] },
  });
});

describe('store.recordUsage', () => {
  it('accumulates time + tokens per (workItem, agent) and returns the running total', () => {
    const first = store.recordUsage({
      projectId: project.id,
      workItemId: 'wi_1',
      agentId: 'agent_a',
      inputTokens: 100,
      outputTokens: 20,
      timeMs: 1500,
      turns: 1,
    });
    expect(first.inputTokens).toBe(100);
    expect(first.turns).toBe(1);

    const second = store.recordUsage({
      projectId: project.id,
      workItemId: 'wi_1',
      agentId: 'agent_a',
      outputTokens: 30,
      timeMs: 500,
      turns: 1,
    });
    // Same key -> accumulates.
    expect(second.inputTokens).toBe(100);
    expect(second.outputTokens).toBe(50);
    expect(second.timeMs).toBe(2000);
    expect(second.turns).toBe(2);

    const all = store.listUsage(project.id);
    expect(all).toHaveLength(1);
  });

  it('keeps separate rows per agent and per work item, including null (general) work', () => {
    store.recordUsage({ projectId: project.id, workItemId: 'wi_1', agentId: 'a', inputTokens: 10 });
    store.recordUsage({ projectId: project.id, workItemId: 'wi_1', agentId: 'b', inputTokens: 5 });
    store.recordUsage({ projectId: project.id, workItemId: 'wi_2', agentId: 'a', inputTokens: 7 });
    store.recordUsage({ projectId: project.id, workItemId: null, agentId: 'a', inputTokens: 3 });
    store.recordUsage({ projectId: project.id, workItemId: null, agentId: 'a', inputTokens: 4 });

    const all = store.listUsage(project.id);
    // 4 distinct keys: (wi_1,a) (wi_1,b) (wi_2,a) (null,a)
    expect(all).toHaveLength(4);
    const general = all.find((u) => u.workItemId === null && u.agentId === 'a');
    expect(general?.inputTokens).toBe(7); // 3 + 4 accumulated on the null-item row
  });

  it('ignores empty deltas gracefully (no negative counts)', () => {
    const row = store.recordUsage({
      projectId: project.id,
      workItemId: 'wi_1',
      agentId: 'a',
      inputTokens: -5,
    });
    expect(row.inputTokens).toBe(0);
  });
});
