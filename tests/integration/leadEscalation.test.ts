import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestApp, rmDir, type TestApp } from '../helpers/testApp.js';
import { execFileSync } from 'node:child_process';

let ctx: TestApp;
let repoDir: string;

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-repo-'));
  // A real git repo so epic worktrees can be created.
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' };
  execFileSync('git', ['init', '-q'], { cwd: repoDir, env });
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', '.'], { cwd: repoDir, env });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoDir, env });
  ctx = createTestApp();
});

afterEach(async () => {
  await ctx.close();
  rmDir(repoDir);
});

async function createProject(name = 'Lead Escalation'): Promise<string> {
  const res = await ctx.app.inject({ method: 'POST', url: '/api/projects', payload: { name, repoDir } });
  expect(res.statusCode).toBe(201);
  return (res.json() as { project: { id: string } }).project.id;
}

async function addNoopBuilder(projectId: string): Promise<void> {
  await ctx.app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/agents`,
    payload: {
      catalogId: 'backend-engineer',
      name: 'backend',
      prompt: 'You are the Backend Engineer. [[NOOP]] You describe work but write no files.',
    },
  });
}

async function chat(projectId: string, content: string): Promise<void> {
  const res = await ctx.app.inject({ method: 'POST', url: `/api/projects/${projectId}/chat`, payload: { content } });
  expect(res.statusCode).toBeLessThan(300);
}

describe('Lead-first escalation (Items 1 & 3)', () => {
  it('the Team Lead makes a decision and re-drives BEFORE parking the run on the user', async () => {
    const projectId = await createProject();
    await addNoopBuilder(projectId);
    await chat(projectId, 'Please build an orders API.');

    // The no-code fallback question still surfaces (guaranteed backstop)…
    const q = await ctx.waitFor(
      (m) => m.type === 'question.updated' && /produced no code/i.test(m.question.question),
      15000,
    );
    expect(q.type === 'question.updated' && q.question.status).toBe('pending');

    // …but ONLY after the Lead first stepped in: the blocked task carries a
    // persisted Lead decision, and the Lead posted an unblock message. That is
    // the AC1 proof — a Lead-made decision precedes the human prompt.
    const blocked = ctx.store.listWorkItems(projectId).find((w) => w.kind === 'task' && (w.description ?? '').includes('lead-decision'));
    expect(blocked, 'a task should carry the Lead decision marker').toBeTruthy();
    expect(blocked!.description).toContain('Team Lead decision (unblock)');

    const leadMsg = ctx.messages.find(
      (m) => m.type === 'chat.message' && /here's the call so you can proceed/i.test(m.message.content),
    );
    expect(leadMsg, 'the Lead should post unblock guidance to the agent').toBeTruthy();
  });
});

describe('@mention wakes the Lead to take over (Item 2)', () => {
  it('@team-lead clears the parked no-code question and re-drives, and does NOT touch unrelated escalations (B1)', async () => {
    const projectId = await createProject();
    await addNoopBuilder(projectId);
    await chat(projectId, 'Please build an orders API.');

    const q = await ctx.waitFor(
      (m) => m.type === 'question.updated' && /produced no code/i.test(m.question.question),
      15000,
    );
    const noCodeQId = q.type === 'question.updated' ? q.question.id : '';
    expect(noCodeQId).toBeTruthy();
    const blockedItem = ctx.store
      .listWorkItems(projectId)
      .find((w) => w.kind === 'task' && (w.description ?? '').includes('lead-decision'));
    const sameAgentId = blockedItem?.assigneeAgentId ?? null;

    // Two UNRELATED escalations the take-over must never answer: one with no
    // agent, and one owned by the SAME agent as the no-code blocker (the exact
    // hazard the noCodeQuestions map guards against — B1).
    const unrelated = ctx.store.createQuestion({
      projectId,
      agentId: null,
      question: 'Epic review budget exhausted — keep working or merge anyway?',
      choices: ['Keep working', 'Merge anyway'],
    });
    const unrelatedSameAgent = ctx.store.createQuestion({
      projectId,
      agentId: sameAgentId,
      question: 'Integration conflict — keep working or merge anyway?',
      choices: ['Keep working', 'Merge anyway'],
    });

    // The user summons the Lead. Not a build/discuss intent — pure take-over.
    await chat(projectId, '@team-lead are you looking into this issue?');

    // The no-code question is resolved by the Lead (status → answered).
    await ctx.waitFor(
      (m) => m.type === 'question.updated' && m.question.id === noCodeQId && m.question.status === 'answered',
      15000,
    );

    // The unrelated escalations are untouched (scoping — B1), including the one
    // owned by the same agent as the no-code blocker.
    const stillPending = ctx.store.listQuestions(projectId).find((x) => x.id === unrelated.id);
    expect(stillPending?.status).toBe('pending');
    const sameAgentStill = ctx.store
      .listQuestions(projectId)
      .find((x) => x.id === unrelatedSameAgent.id);
    expect(sameAgentStill?.status).toBe('pending');
  });
});
