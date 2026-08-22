import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTestApp, rmDir, type TestApp } from '../helpers/testApp.js';
import type { WorkItem } from '../../src/shared/index.js';

let ctx: TestApp;
let repoDir: string;

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-gitrepo-'));
  ctx = createTestApp();
});

afterEach(async () => {
  await ctx.close();
  rmDir(repoDir);
});

function git(args: string[], cwd = repoDir): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function createProject(name: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name, repoDir },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { project: { id: string } }).project.id;
}

async function addSpecialist(projectId: string, catalogId: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/agents`,
    payload: { catalogId },
  });
  return (res.json() as { agent: { id: string } }).agent.id;
}

describe('git clone isolation per epic (Phase 3)', () => {
  it('an epic gets its own branch + isolated clone and a task commits on it', async () => {
    const projectId = await createProject('Git One');
    await addSpecialist(projectId, 'frontend-engineer');

    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chat`,
      payload: { content: 'Please build a settings page.' },
    });

    // Epic opens and gets an ateam/epic-* branch.
    const epicMsg = (await ctx.waitFor(
      (m) =>
        m.type === 'workitem.updated' &&
        m.workItem.kind === 'epic' &&
        !!m.workItem.branch &&
        m.workItem.branch.startsWith('ateam/epic-'),
      8000,
    )) as Extract<import('../../src/shared/index.js').ServerMessage, { type: 'workitem.updated' }>;
    const branch = epicMsg.workItem.branch!;
    const epicId = epicMsg.workItem.id;

    // The epic runs in its OWN clone under the worktree root (its own .git dir),
    // NOT a linked worktree of repoDir — this is what makes agent edits land on
    // the epic branch.
    const cloneDir = path.join(ctx.worktreeRoot, projectId, epicId);
    expect(fs.existsSync(path.join(cloneDir, '.git'))).toBe(true);
    expect(fs.statSync(path.join(cloneDir, '.git')).isDirectory()).toBe(true); // clone, not worktree file
    const branches = git(['branch', '--format=%(refname:short)'], cloneDir).split('\n');
    expect(branches).toContain(branch);

    // The builder task commits real work on the epic branch (a real commit).
    await ctx.waitFor(
      (m) =>
        m.type === 'event.appended' &&
        m.event.type === 'git' &&
        m.event.summary.startsWith('Committed'),
      8000,
    );
    const log = git(['log', branch, '--oneline'], cloneDir);
    expect(log).toMatch(/task\(frontend\)/);
  });

  it('two parallel epics get separate branches + isolated clones', async () => {
    const projectId = await createProject('Git Two');
    await addSpecialist(projectId, 'frontend-engineer');

    for (const content of ['Please build feature A.', 'Please build feature B.']) {
      await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/chat`,
        payload: { content },
      });
    }

    // Wait until two distinct epics exist.
    await ctx.waitFor(() => {
      const epics = ctx.store.listWorkItems(projectId).filter((i) => i.kind === 'epic' && i.branch);
      return epics.length >= 2;
    }, 10000);

    const epics = ctx.store
      .listWorkItems(projectId)
      .filter((i: WorkItem) => i.kind === 'epic' && i.branch);
    const epicBranches = epics.map((e) => e.branch!);
    expect(new Set(epicBranches).size).toBe(2);

    // Each epic has its own isolated clone directory checked out to its branch.
    for (const e of epics) {
      const cloneDir = path.join(ctx.worktreeRoot, projectId, e.id);
      expect(fs.existsSync(path.join(cloneDir, '.git'))).toBe(true);
      const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], cloneDir);
      expect(current).toBe(e.branch);
    }
  });
});
