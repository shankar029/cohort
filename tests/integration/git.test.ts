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

describe('git worktree isolation per epic (Phase 3)', () => {
  it('an epic gets its own branch + worktree and a task commits on it', async () => {
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

    // The repo is now a git repo and the epic branch exists.
    expect(fs.existsSync(path.join(repoDir, '.git'))).toBe(true);
    const branches = git(['branch', '--format=%(refname:short)']).split('\n');
    expect(branches).toContain(branch);

    // The builder task commits its audit note on the epic branch (a real commit).
    await ctx.waitFor(
      (m) =>
        m.type === 'event.appended' &&
        m.event.type === 'git' &&
        m.event.summary.startsWith('Committed'),
      8000,
    );
    const log = git(['log', branch, '--oneline']);
    expect(log).toMatch(/task\(frontend\)/);
  });

  it('two parallel epics get separate branches + worktrees', async () => {
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
    await ctx.waitFor((m) => {
      if (m.type !== 'workitem.updated') return false;
      const epics = ctx.store.listWorkItems(projectId).filter((i) => i.kind === 'epic' && i.branch);
      return epics.length >= 2;
    }, 10000);

    const epics = ctx.store
      .listWorkItems(projectId)
      .filter((i: WorkItem) => i.kind === 'epic' && i.branch);
    const epicBranches = epics.map((e) => e.branch!);
    expect(new Set(epicBranches).size).toBe(2);

    const repoBranches = git(['branch', '--format=%(refname:short)']).split('\n');
    for (const b of epicBranches) expect(repoBranches).toContain(b);

    // Each epic has its own on-disk worktree registered.
    const worktrees = git(['worktree', 'list']);
    expect(worktrees.split('\n').length).toBeGreaterThanOrEqual(3); // main + 2 epics
  });
});
