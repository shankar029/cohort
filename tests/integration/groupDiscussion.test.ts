import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTestApp, rmDir, type TestApp } from '../helpers/testApp.js';

let ctx: TestApp;
let repoDir: string;

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-gd-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@e',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@e',
  };
  execFileSync('git', ['init', '-q'], { cwd: repoDir, env });
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# app\n');
  execFileSync('git', ['add', '.'], { cwd: repoDir, env });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoDir, env });
  ctx = createTestApp();
});

afterEach(async () => {
  await ctx.close();
  rmDir(repoDir);
});

async function createProject(name: string): Promise<string> {
  const res = await ctx.app.inject({ method: 'POST', url: '/api/projects', payload: { name, repoDir } });
  expect(res.statusCode).toBe(201);
  return (res.json() as { project: { id: string } }).project.id;
}

async function addAgent(projectId: string, catalogId: string, prompt?: string): Promise<void> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/agents`,
    payload: { catalogId, ...(prompt ? { prompt } : {}) },
  });
  expect(res.statusCode).toBeLessThan(300);
}

async function chat(projectId: string, content: string): Promise<void> {
  const res = await ctx.app.inject({ method: 'POST', url: `/api/projects/${projectId}/chat`, payload: { content } });
  expect(res.statusCode).toBeLessThan(300);
}

describe('agent-initiated bounded group discussion (AC6)', () => {
  it('a builder that needs input opens a group thread, the decider resolves it, the decision is persisted, and NO human question is raised', async () => {
    const projectId = await createProject('Group Discussion');
    // A backend engineer whose persona forces it to request a discussion. It still
    // writes a deliverable (no [[NOOP]]), so it never hits the empty-build gate.
    await addAgent(
      projectId,
      'backend-engineer',
      'You are the Backend Engineer. [[NEEDS_DISCUSSION]] Raise a group discussion about the API contract.',
    );
    await addAgent(projectId, 'frontend-engineer');
    await addAgent(projectId, 'qa-engineer');

    let sawQuestion = false;
    const off = ctx.bus.subscribe((m) => {
      if (m.type === 'question.updated') sawQuestion = true;
    });

    await chat(projectId, 'Build a small orders API endpoint.');

    // The agent-initiated discussion thread (kind 'group', includesUser=false —
    // distinct from the epic's own 'Team discussion' thread which includes the user).
    const groupThread = await ctx.waitFor(
      (m) => m.type === 'thread.updated' && m.thread.kind === 'group' && m.thread.includesUser === false,
      15000,
    );
    expect(
      groupThread.type === 'thread.updated' && groupThread.thread.participantAgentIds.length,
    ).toBeGreaterThan(1);

    // The decider writes the decision back onto a work item under the DISTINCT
    // group-decision marker (never the lead-decision one).
    const decided = await ctx.waitFor(
      (m) =>
        m.type === 'workitem.updated' &&
        (m.workItem.description ?? '').includes('<!--group-decision-->'),
      15000,
    );
    expect(decided.type === 'workitem.updated' && decided.workItem.description).toContain(
      'Team decision',
    );
    // Scoping: the group decision must NOT masquerade as a lead one-shot unblock.
    expect(decided.type === 'workitem.updated' && decided.workItem.description).not.toContain(
      '<!--lead-decision-->',
    );

    // The discussion resolved WITHIN the team — no human prompt surfaced.
    await new Promise((r) => setTimeout(r, 300));
    off();
    expect(sawQuestion).toBe(false);

    // The group thread was created with includesUser=false (agent-initiated).
    const threads = ctx.store.listThreads(projectId).filter((t) => t.kind === 'group' && t.includesUser === false);
    expect(threads.length).toBeGreaterThan(0);
  });
});
