import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestApp, rmDir, type TestApp } from '../helpers/testApp.js';
import type { WorkItem, RecordedTurnSummary, RecordedTurn } from '../../src/shared/index.js';

let ctx: TestApp;
let repoDir: string;

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-repo-'));
  ctx = createTestApp();
});

afterEach(async () => {
  await ctx.close();
  rmDir(repoDir);
  rmDir(ctx.recordingsRoot);
});

async function createProject(): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name: 'Rec', repoDir },
  });
  return (res.json() as { project: { id: string } }).project.id;
}

async function addSpecialist(projectId: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/agents`,
    payload: { catalogId: 'frontend-engineer' },
  });
  return (res.json() as { agent: { id: string } }).agent.id;
}

async function assignTask(projectId: string, agentId: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/workitems`,
    payload: { title: 'Build a settings panel', status: 'todo', assigneeAgentId: agentId },
  });
  return (res.json() as { workItem: WorkItem }).workItem.id;
}

async function waitReview(itemId: string): Promise<void> {
  await ctx.waitFor(
    (m) =>
      m.type === 'workitem.updated' && m.workItem.id === itemId && m.workItem.status === 'review',
    10000,
  );
}

describe('session recording', () => {
  it('captures full agent turns when enabled', async () => {
    const projectId = await createProject();
    const agentId = await addSpecialist(projectId);

    // Turn recording on BEFORE any work runs.
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}`,
      payload: { recordSessions: true },
    });

    const itemId = await assignTask(projectId, agentId);
    await waitReview(itemId);

    const listRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/recordings`,
    });
    const list = listRes.json() as { enabled: boolean; recordings: RecordedTurnSummary[] };
    expect(list.enabled).toBe(true);
    expect(list.recordings.length).toBeGreaterThan(0);

    const summary = list.recordings.find((r) => r.agentId === agentId)!;
    expect(summary).toBeTruthy();
    expect(summary.promptPreview.length).toBeGreaterThan(0);

    // Full detail carries the exact prompt and reply.
    const detailRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/recordings/${summary.id}`,
    });
    const detail = (detailRes.json() as { recording: RecordedTurn }).recording;
    expect(detail.prompt).toContain('Build a settings panel');
    expect(typeof detail.response).toBe('string');
    expect(detail.durationMs).toBeGreaterThanOrEqual(0);

    // Markdown + JSONL exports are non-empty.
    const md = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/recordings/export.md`,
    });
    expect(md.body).toContain('# Session recordings');
    const jsonl = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/recordings/export.jsonl`,
    });
    expect(jsonl.body).toContain(summary.id);
  });

  it('records nothing when disabled (default)', async () => {
    const projectId = await createProject();
    const agentId = await addSpecialist(projectId);
    const itemId = await assignTask(projectId, agentId);
    await waitReview(itemId);

    const listRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/recordings`,
    });
    const list = listRes.json() as { enabled: boolean; recordings: RecordedTurnSummary[] };
    expect(list.enabled).toBe(false);
    expect(list.recordings).toHaveLength(0);
  });

  it('clears recordings on request', async () => {
    const projectId = await createProject();
    const agentId = await addSpecialist(projectId);
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}`,
      payload: { recordSessions: true },
    });
    const itemId = await assignTask(projectId, agentId);
    await waitReview(itemId);

    const before = (
      (
        await ctx.app.inject({ method: 'GET', url: `/api/projects/${projectId}/recordings` })
      ).json() as { recordings: RecordedTurnSummary[] }
    ).recordings;
    expect(before.length).toBeGreaterThan(0);

    await ctx.app.inject({ method: 'DELETE', url: `/api/projects/${projectId}/recordings` });

    const after = (
      (
        await ctx.app.inject({ method: 'GET', url: `/api/projects/${projectId}/recordings` })
      ).json() as { recordings: RecordedTurnSummary[] }
    ).recordings;
    expect(after).toHaveLength(0);
  });
});
