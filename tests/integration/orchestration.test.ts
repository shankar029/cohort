import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestApp, type TestApp } from '../helpers/testApp.js';
import type { WorkItem, Question, AgentTask } from '../../src/shared/index.js';

let ctx: TestApp;
let repoDir: string;

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-repo-'));
  ctx = createTestApp();
});

afterEach(async () => {
  await ctx.close();
  fs.rmSync(repoDir, { recursive: true, force: true });
});

async function createProject(name = 'Demo'): Promise<{ projectId: string; leadId: string }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name, repoDir },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as {
    project: { id: string };
    agents: Array<{ id: string; kind: string }>;
  };
  const lead = body.agents.find((a) => a.kind === 'lead')!;
  return { projectId: body.project.id, leadId: lead.id };
}

async function addSpecialist(projectId: string, catalogId = 'frontend-engineer'): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/agents`,
    payload: { catalogId },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

describe('project lifecycle', () => {
  it('creates a project with a Team Lead auto-provisioned', async () => {
    const { projectId } = await createProject();
    const res = await ctx.app.inject({ method: 'GET', url: `/api/projects/${projectId}/agents` });
    const agents = (res.json() as { agents: Array<{ kind: string; displayName: string }> }).agents;
    expect(agents).toHaveLength(1);
    expect(agents[0]!.kind).toBe('lead');
    expect(agents[0]!.displayName).toBe('Team Lead');
  });

  it('rejects a project whose repo dir does not exist', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Bad', repoDir: path.join(repoDir, 'does-not-exist') },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('catalog + team building', () => {
  it('exposes a catalog of specialized agents', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/catalog' });
    const agents = (res.json() as { agents: unknown[] }).agents;
    expect(agents.length).toBeGreaterThanOrEqual(8);
  });

  it('adds a specialist from the catalog', async () => {
    const { projectId } = await createProject();
    await addSpecialist(projectId);
    const res = await ctx.app.inject({ method: 'GET', url: `/api/projects/${projectId}/agents` });
    const agents = (res.json() as { agents: Array<{ kind: string; name: string }> }).agents;
    expect(agents.some((a) => a.kind === 'specialist' && a.name === 'frontend')).toBe(true);
  });
});

describe('board-driven autonomous work', () => {
  it('an assigned work item is auto-picked-up and advances to review', async () => {
    const { projectId } = await createProject();
    const agentId = await addSpecialist(projectId);

    const create = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workitems`,
      payload: { title: 'Build the login screen', status: 'todo', assigneeAgentId: agentId },
    });
    const item = (create.json() as { workItem: WorkItem }).workItem;

    const reviewed = (await ctx.waitFor(
      (m) =>
        m.type === 'workitem.updated' &&
        m.workItem.id === item.id &&
        m.workItem.status === 'review',
    )) as Extract<import('../../src/shared/index.js').ServerMessage, { type: 'workitem.updated' }>;
    expect(reviewed.workItem.status).toBe('review');

    // The agent maintained a task board for this item.
    const tasksRes = await ctx.app.inject({ method: 'GET', url: `/api/agents/${agentId}/tasks` });
    const tasks = (tasksRes.json() as { tasks: AgentTask[] }).tasks;
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.some((t) => t.status === 'done')).toBe(true);

    // Activity was logged for the agent.
    const eventsRes = await ctx.app.inject({ method: 'GET', url: `/api/agents/${agentId}/events` });
    const events = (eventsRes.json() as { events: unknown[] }).events;
    expect(events.length).toBeGreaterThan(0);
  });

  it('after finishing one item, the agent pulls the next assigned item', async () => {
    const { projectId } = await createProject();
    const agentId = await addSpecialist(projectId);

    for (const title of ['First task', 'Second task']) {
      await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/workitems`,
        payload: { title, status: 'todo', assigneeAgentId: agentId },
      });
    }

    // Both items should eventually reach review via the pull-loop.
    await ctx.waitFor(
      (m) =>
        m.type === 'workitem.updated' &&
        m.workItem.title === 'First task' &&
        m.workItem.status === 'review',
    );
    await ctx.waitFor(
      (m) =>
        m.type === 'workitem.updated' &&
        m.workItem.title === 'Second task' &&
        m.workItem.status === 'review',
      8000,
    );
    const items = ctx.store.listWorkItems(projectId);
    expect(items.every((i) => i.status === 'review')).toBe(true);
  });
});

describe('chat delegation', () => {
  it('the Team Lead streams a reply and delegates to a named specialist', async () => {
    const { projectId } = await createProject();
    await addSpecialist(projectId);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chat`,
      payload: { content: 'Please delegate to `frontend` to build the header.' },
    });
    expect(res.statusCode).toBe(202);

    // A streamed delta arrives, then a final lead message.
    await ctx.waitFor((m) => m.type === 'chat.delta');
    await ctx.waitFor(
      (m) => m.type === 'chat.message' && m.message.role === 'lead' && m.message.content.length > 0,
    );
    // A subagent event was logged.
    await ctx.waitFor((m) => m.type === 'event.appended' && m.event.type === 'subagent_started');
  });
});

describe('escalation (specialist → team lead → user)', () => {
  it('raises a question and resumes once the user answers', async () => {
    const { projectId } = await createProject();
    const agentId = await addSpecialist(projectId);

    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workitems`,
      payload: { title: 'Ambiguous task [[ASK]]', status: 'todo', assigneeAgentId: agentId },
    });

    const questionMsg = (await ctx.waitFor(
      (m) => m.type === 'question.updated' && m.question.status === 'pending',
    )) as Extract<import('../../src/shared/index.js').ServerMessage, { type: 'question.updated' }>;
    const question: Question = questionMsg.question;
    expect(question.choices).toBeTruthy();

    const answerRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/questions/${question.id}/answer`,
      payload: { answer: 'Option A' },
    });
    expect(answerRes.statusCode).toBe(200);

    // Work resumes and reaches review after the answer.
    await ctx.waitFor((m) => m.type === 'workitem.updated' && m.workItem.status === 'review', 8000);
  });
});
