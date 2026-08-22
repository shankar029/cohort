import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestApp, rmDir, type TestApp } from '../helpers/testApp.js';

let ctx: TestApp;
const repos: string[] = [];

beforeEach(() => {
  ctx = createTestApp();
});

afterEach(async () => {
  await ctx.close();
  while (repos.length) rmDir(repos.pop()!);
});

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-regrepo-'));
  repos.push(dir);
  return dir;
}

async function createProject(name: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name, repoDir: makeRepo() },
  });
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

async function chat(projectId: string, content: string): Promise<void> {
  await ctx.app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/chat`,
    payload: { content },
  });
}

describe('regression: subtle cross-cutting behaviors', () => {
  it('keeps two projects fully isolated (boards, chat, agents)', async () => {
    const a = await createProject('Alpha');
    const b = await createProject('Beta');
    await addSpecialist(a, 'frontend-engineer');
    await addSpecialist(b, 'backend-engineer');

    await chat(a, 'Please build the alpha landing page.');
    await chat(b, 'Please build the beta API.');

    // Each project's epic reaches its own board only.
    await ctx.waitFor(
      (m) =>
        m.type === 'workitem.updated' &&
        m.projectId === a &&
        m.workItem.kind === 'epic' &&
        m.workItem.status === 'in_progress',
      12000,
    );
    await ctx.waitFor(
      (m) =>
        m.type === 'workitem.updated' &&
        m.projectId === b &&
        m.workItem.kind === 'epic' &&
        m.workItem.status === 'in_progress',
      12000,
    );

    const aItems = ctx.store.listWorkItems(a);
    const bItems = ctx.store.listWorkItems(b);
    // No Alpha item mentions Beta's work and vice-versa.
    expect(aItems.some((w) => /beta/i.test(w.title))).toBe(false);
    expect(bItems.some((w) => /alpha/i.test(w.title))).toBe(false);
    // Agents don't leak across projects.
    const aAgents = ctx.store.listAgents(a).map((x) => x.name);
    const bAgents = ctx.store.listAgents(b).map((x) => x.name);
    expect(aAgents).toContain('frontend');
    expect(aAgents).not.toContain('backend');
    expect(bAgents).toContain('backend');
    expect(bAgents).not.toContain('frontend');
    // Chat is per-project.
    const aChat = ctx.store.listChat(a).map((m) => m.content);
    expect(aChat.some((c) => /beta API/i.test(c))).toBe(false);
  });

  it('rolls epic progress up to 100 only when every child task is done', async () => {
    const p = await createProject('Rollup');
    await addSpecialist(p, 'frontend-engineer');
    await addSpecialist(p, 'qa-engineer');

    await chat(p, 'Please build a contact form.');

    // The epic reaches 100% and closes only after the PR merges (all children done).
    const merged = await ctx.waitFor(
      (m) =>
        m.type === 'workitem.updated' &&
        m.projectId === p &&
        m.workItem.kind === 'epic' &&
        m.workItem.status === 'done',
      15000,
    );
    expect(merged.type === 'workitem.updated' && merged.workItem.progress).toBe(100);

    const items = ctx.store.listWorkItems(p);
    const epic = items.find((w) => w.kind === 'epic')!;
    const children = items.filter((w) => w.parentId === epic.id);
    expect(children.length).toBeGreaterThan(0);
    // Every child ended done, and the epic's progress equals the child average (100).
    expect(children.every((c) => c.status === 'done')).toBe(true);
  });

  it('marks all review comments resolved before the epic can merge', async () => {
    const p = await createProject('Gating');
    await addSpecialist(p, 'frontend-engineer');
    // A reviewer that always files a comment (deduped) so the gate is exercised.
    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${p}/agents`,
      payload: {
        name: 'reviewer',
        displayName: 'Reviewer',
        prompt: 'You review PRs. [[REVIEW_COMMENT: frontend | tighten error handling]]',
      },
    });

    await chat(p, 'Please build a login form.');

    await ctx.waitFor(
      (m) => m.type === 'pull_request.updated' && m.projectId === p && m.pr.status === 'merged',
      15000,
    );
    const comments = ctx.store.listProjectPrComments(p);
    expect(comments.length).toBeGreaterThan(0);
    // The merge only happened because every comment was resolved.
    expect(comments.every((c) => c.status === 'resolved')).toBe(true);
  });
});
