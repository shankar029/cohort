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

describe('store epic metrics', () => {
  const base = {
    taskCount: 4,
    builderCount: 3,
    independentBuilders: 2,
    maxConcurrent: 2,
    integrationConflicts: 0,
    durationMs: 12000,
  };

  it('records and reads back a metrics row', () => {
    const saved = store.recordEpicMetrics({ epicId: 'wi_e1', projectId: project.id, ...base });
    expect(saved.createdAt).toBeTruthy();
    const got = store.getEpicMetrics('wi_e1');
    expect(got).toMatchObject({ epicId: 'wi_e1', taskCount: 4, independentBuilders: 2 });
  });

  it('upserts on the same epic id rather than duplicating', () => {
    store.recordEpicMetrics({ epicId: 'wi_e1', projectId: project.id, ...base });
    store.recordEpicMetrics({
      epicId: 'wi_e1',
      projectId: project.id,
      ...base,
      maxConcurrent: 5,
      integrationConflicts: 1,
    });
    const list = store.listEpicMetrics(project.id);
    expect(list.length).toBe(1);
    expect(list[0]!.maxConcurrent).toBe(5);
    expect(list[0]!.integrationConflicts).toBe(1);
  });

  it('lists metrics for a project in insertion order', () => {
    store.recordEpicMetrics({ epicId: 'wi_a', projectId: project.id, ...base });
    store.recordEpicMetrics({ epicId: 'wi_b', projectId: project.id, ...base });
    expect(store.listEpicMetrics(project.id).map((m) => m.epicId)).toEqual(['wi_a', 'wi_b']);
    expect(store.getEpicMetrics('wi_missing')).toBeUndefined();
  });
});
