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
});
