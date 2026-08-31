import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestApp, rmDir, type TestApp } from '../helpers/testApp.js';

let ctx: TestApp;
let repoDir: string;

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-vrepo-'));
  ctx = createTestApp();
});

afterEach(async () => {
  await ctx.close();
  rmDir(repoDir);
});

describe('verification report persistence (slice 2)', () => {
  it('persists reports and exposes them via the API (latest + history)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Verif', repoDir },
    });
    const projectId = (res.json() as { project: { id: string } }).project.id;

    // Insert two reports for the same work item directly via the store.
    const store = ctx.store;
    store.insertVerification({
      projectId,
      workItemId: 'wi_x',
      agentId: 'agt_x',
      scope: 'task',
      stream: 'backend',
      passed: false,
      outcome: 'failed',
      checks: [
        { id: 'build', severity: 'required', status: 'pass', detail: 'ok' },
        { id: 'constraints', severity: 'required', status: 'fail', detail: 'disk write' },
      ],
    });
    store.insertVerification({
      projectId,
      workItemId: 'wi_x',
      agentId: 'agt_x',
      scope: 'task',
      stream: 'backend',
      passed: true,
      outcome: 'passed',
      checks: [{ id: 'constraints', severity: 'required', status: 'pass', detail: 'clean' }],
    });

    const itemRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/workitems/wi_x/verification',
    });
    const body = itemRes.json() as {
      latest: { passed: boolean; outcome: string } | null;
      history: unknown[];
    };
    expect(body.history).toHaveLength(2);
    expect(body.latest?.passed).toBe(true);
    expect(body.latest?.outcome).toBe('passed');

    const projRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/verification`,
    });
    const proj = projRes.json() as { reports: unknown[] };
    expect(proj.reports.length).toBe(2);
  });

  it('persists a passing epic-scoped (merge-authority) report when an epic merges', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'EpicAuthority', repoDir },
    });
    const projectId = (res.json() as { project: { id: string } }).project.id;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/agents`,
      payload: { catalogId: 'backend-engineer' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chat`,
      payload: { content: 'Please build a small tested service.' },
    });

    await ctx.waitFor((m) => m.type === 'pull_request.updated' && m.pr.status === 'merged', 20000);

    const proj = (await ctx.app
      .inject({ method: 'GET', url: `/api/projects/${projectId}/verification` })
      .then((r) => r.json())) as {
      reports: { scope: string; outcome: string; passed: boolean; checks: { id: string }[] }[];
    };
    const epicReport = proj.reports.find((r) => r.scope === 'epic');
    expect(epicReport).toBeTruthy();
    expect(epicReport!.passed).toBe(true);
    expect(epicReport!.outcome).toBe('passed');
    // The merge-authority report carries the epic-scope checks.
    expect(epicReport!.checks.some((c) => c.id === 'integrated-build')).toBe(true);
    expect(epicReport!.checks.some((c) => c.id === 'acceptance')).toBe(true);
  });
});
