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

describe('store acceptance criteria', () => {
  it('persists criteria for an epic and lists them in order, all open', () => {
    const saved = store.replaceCriteria({
      projectId: project.id,
      epicId: 'wi_epic',
      texts: ['Given A when B then C', 'Given X when Y then Z'],
    });
    expect(saved.length).toBe(2);
    const listed = store.listCriteria('wi_epic');
    expect(listed.map((c) => c.text)).toEqual(['Given A when B then C', 'Given X when Y then Z']);
    expect(listed.every((c) => c.status === 'open')).toBe(true);
    expect(listed.every((c) => c.epicId === 'wi_epic')).toBe(true);
  });

  it('replaceCriteria is idempotent — it swaps the full set, not appends', () => {
    store.replaceCriteria({ projectId: project.id, epicId: 'wi_epic', texts: ['one', 'two'] });
    store.replaceCriteria({ projectId: project.id, epicId: 'wi_epic', texts: ['only'] });
    const listed = store.listCriteria('wi_epic');
    expect(listed.map((c) => c.text)).toEqual(['only']);
  });

  it('updates a criterion status and deletes the whole set', () => {
    const [a] = store.replaceCriteria({
      projectId: project.id,
      epicId: 'wi_epic',
      texts: ['a', 'b'],
    });
    store.setCriterionStatus(a!.id, 'met');
    expect(store.listCriteria('wi_epic').find((c) => c.id === a!.id)?.status).toBe('met');
    store.deleteCriteria('wi_epic');
    expect(store.listCriteria('wi_epic')).toEqual([]);
  });
});
