import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTestApp, rmDir, type TestApp } from '../helpers/testApp.js';
import type { PullRequest } from '../../src/shared/index.js';

let ctx: TestApp;
let repoDir: string;

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-prrepo-'));
  ctx = createTestApp();
});

afterEach(async () => {
  await ctx.close();
  rmDir(repoDir);
});

async function createProject(name: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name, repoDir },
  });
  return (res.json() as { project: { id: string } }).project.id;
}

async function addSpecialist(projectId: string, catalogId: string): Promise<void> {
  await ctx.app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/agents`,
    payload: { catalogId },
  });
}

describe('PR + review + iterate-to-quality (Phase 4)', () => {
  it('raises a PR, requests changes, then approves and merges the epic', async () => {
    const projectId = await createProject('PR Flow');
    await addSpecialist(projectId, 'frontend-engineer');
    await addSpecialist(projectId, 'qa-engineer'); // acts as reviewer

    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chat`,
      payload: { content: 'Please build a profile page.' },
    });

    // The reviewer asks for changes on the first round (iterate-to-quality).
    await ctx.waitFor(
      (m) => m.type === 'pull_request.updated' && m.pr.status === 'changes_requested',
      12000,
    );

    // After the rework, the PR is approved and merged.
    const merged = (await ctx.waitFor(
      (m) => m.type === 'pull_request.updated' && m.pr.status === 'merged',
      12000,
    )) as { type: 'pull_request.updated'; pr: PullRequest };
    expect(merged.pr.branch).toMatch(/^ateam\/epic-/);

    // The epic is closed.
    await ctx.waitFor(
      (m) =>
        m.type === 'workitem.updated' && m.workItem.kind === 'epic' && m.workItem.status === 'done',
      12000,
    );

    // The epic branch was really merged into the base branch.
    const log = execFileSync('git', ['log', '--oneline', '--merges'], {
      cwd: repoDir,
      encoding: 'utf8',
    });
    expect(log).toMatch(/merge ateam\/epic-/i);

    const pulls = ctx.store.listPRs(projectId);
    expect(pulls).toHaveLength(1);
    expect(pulls[0]!.status).toBe('merged');
  });
});
