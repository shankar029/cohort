import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestApp, rmDir, type TestApp } from '../helpers/testApp.js';
import type { WorkItem, Question, AgentTask } from '../../src/shared/index.js';

let ctx: TestApp;
let repoDir: string;

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-repo-'));
  ctx = createTestApp();
});

afterEach(async () => {
  await ctx.close();
  rmDir(repoDir);
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

describe('chat: multi-agent discussion', () => {
  it('the Team Lead replies and convenes a discussion where a specialist contributes', async () => {
    const { projectId, leadId } = await createProject();
    const frontendId = await addSpecialist(projectId);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chat`,
      payload: { content: "Let's brainstorm the approach for the header component." },
    });
    expect(res.statusCode).toBe(202);

    // A streamed delta arrives, then a final message from the Team Lead.
    await ctx.waitFor((m) => m.type === 'chat.delta');
    await ctx.waitFor(
      (m) =>
        m.type === 'chat.message' &&
        m.message.authorAgentId === leadId &&
        m.message.content.length > 0,
    );
    // The convened discussion produces a real contribution from the specialist.
    await ctx.waitFor(
      (m) =>
        m.type === 'chat.message' &&
        m.message.authorAgentId === frontendId &&
        m.message.content.length > 0,
      8000,
    );
    // A group thread was opened for the discussion.
    await ctx.waitFor((m) => m.type === 'thread.updated' && m.thread.kind === 'group');
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

describe('scheduled + recurring work items', () => {
  it('activates a scheduled item at its time and the assignee picks it up', async () => {
    const { projectId } = await createProject();
    const agentId = await addSpecialist(projectId);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workitems`,
      payload: {
        title: 'Nightly report',
        assigneeAgentId: agentId,
        scheduledAt: Date.now() + 150,
      },
    });
    expect(res.statusCode).toBe(201);
    const item = (res.json() as { workItem: WorkItem }).workItem;
    // Parked in backlog until its scheduled time.
    expect(item.status).toBe('backlog');
    expect(item.scheduledAt).toBeGreaterThan(Date.now());

    // Fires, activates, and is worked to review autonomously.
    await ctx.waitFor(
      (m) =>
        m.type === 'workitem.updated' &&
        m.workItem.title === 'Nightly report' &&
        m.workItem.status === 'review',
      8000,
    );
  });

  it('a recurring item spawns the next occurrence when it fires', async () => {
    const { projectId } = await createProject();
    const agentId = await addSpecialist(projectId);

    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workitems`,
      payload: {
        title: 'Hourly sync',
        assigneeAgentId: agentId,
        scheduledAt: Date.now() + 100,
        recurrence: 'hourly',
      },
    });

    // Wait until a future-scheduled occurrence exists (the next one).
    await ctx.waitFor(
      (m) =>
        m.type === 'workitem.updated' &&
        m.workItem.title === 'Hourly sync' &&
        m.workItem.status === 'backlog' &&
        (m.workItem.scheduledAt ?? 0) > Date.now() + 60_000,
      8000,
    );
    const hourly = ctx.store.listWorkItems(projectId).filter((i) => i.title === 'Hourly sync');
    // One activated occurrence + one still-scheduled future occurrence.
    expect(hourly.length).toBeGreaterThanOrEqual(2);
    expect(hourly.some((i) => i.recurrence === 'hourly' && i.scheduledAt! > Date.now())).toBe(true);
  });
});

describe('agents as first-class app users (tool layer)', () => {
  it('an agent creates a board work item via its app tools', async () => {
    const { projectId } = await createProject();
    const agentId = await addSpecialist(projectId);

    // Assigning this item makes the specialist run; the marker drives its create_work_item tool.
    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workitems`,
      payload: {
        title: 'Investigate and [[CREATE_TASK: Write integration tests]]',
        status: 'todo',
        assigneeAgentId: agentId,
      },
    });

    // The tool-created task shows up on the board (via the same store/bus the UI uses).
    const created = (await ctx.waitFor(
      (m) => m.type === 'workitem.updated' && m.workItem.title === 'Write integration tests',
      8000,
    )) as Extract<import('../../src/shared/index.js').ServerMessage, { type: 'workitem.updated' }>;
    expect(created.workItem.kind).toBe('task');

    const items = ctx.store.listWorkItems(projectId).map((i) => i.title);
    expect(items).toContain('Write integration tests');
  });

  it('an agent posts a message to the team via its app tools', async () => {
    const { projectId, leadId } = await createProject();

    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chat`,
      payload: { content: 'Status update please [[POST: Backend API is ready for review]]' },
    });

    await ctx.waitFor(
      (m) =>
        m.type === 'chat.message' &&
        m.message.authorAgentId === leadId &&
        m.message.content.includes('Backend API is ready for review'),
      8000,
    );
  });

  it('an agent maintains a scratchpad (plan + notes) via its app tools', async () => {
    const { projectId } = await createProject();
    const agentId = await addSpecialist(projectId);

    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workitems`,
      payload: {
        title: 'Design schema [[PLAN: 1. model tables 2. migrate]] [[NOTE: chose sqlite]]',
        status: 'todo',
        assigneeAgentId: agentId,
      },
    });

    await ctx.waitFor(
      (m) =>
        m.type === 'agent_plan.updated' && m.agentId === agentId && m.plan.includes('model tables'),
      8000,
    );
    await ctx.waitFor(
      (m) =>
        m.type === 'agent_note.appended' &&
        m.agentId === agentId &&
        m.note.content.includes('sqlite'),
      8000,
    );

    const res = await ctx.app.inject({ method: 'GET', url: `/api/agents/${agentId}/notes` });
    const body = res.json() as { plan: string; notes: Array<{ content: string }> };
    expect(body.plan).toContain('model tables');
    expect(body.notes.some((n) => n.content.includes('sqlite'))).toBe(true);
  });
});

describe('epic planning & decomposition', () => {
  it('a build request becomes an epic decomposed into assigned stream-tagged tasks', async () => {
    const { projectId } = await createProject();
    const feId = await addSpecialist(projectId, 'frontend-engineer');
    const beId = await addSpecialist(projectId, 'backend-engineer');
    await addSpecialist(projectId, 'qa-engineer');

    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chat`,
      payload: { content: 'Please build a user login feature with email and password.' },
    });

    // An epic is opened.
    const epicMsg = (await ctx.waitFor(
      (m) => m.type === 'workitem.updated' && m.workItem.kind === 'epic',
      8000,
    )) as Extract<import('../../src/shared/index.js').ServerMessage, { type: 'workitem.updated' }>;
    const epicId = epicMsg.workItem.id;
    expect(epicMsg.workItem.title.toLowerCase()).toContain('login');

    // Builder tasks are created as children, assigned, stream-tagged, and worked to review.
    await ctx.waitFor(
      (m) =>
        m.type === 'workitem.updated' &&
        m.workItem.parentId === epicId &&
        m.workItem.stream === 'frontend' &&
        m.workItem.status === 'review',
      8000,
    );

    const children = ctx.store.listChildTasks(epicId);
    const streams = children.map((c) => c.stream);
    expect(streams).toEqual(expect.arrayContaining(['frontend', 'backend', 'qa']));
    const fe = children.find((c) => c.stream === 'frontend')!;
    const qa = children.find((c) => c.stream === 'qa')!;
    expect(fe.assigneeAgentId).toBe(feId);
    // QA was created dependency-gated on the builder tasks.
    expect(qa.dependsOn.length).toBeGreaterThanOrEqual(2);
    expect(qa.dependsOn).toContain(fe.id);
    expect(beId).toBeTruthy();

    // Once the builders reach review, the gated QA task is promoted and worked too.
    await ctx.waitFor(
      (m) =>
        m.type === 'workitem.updated' && m.workItem.id === qa.id && m.workItem.status === 'review',
      8000,
    );

    // Let the review-to-merge loop finish so the temp repo is safe to clean up.
    await ctx.waitFor(
      (m) =>
        m.type === 'workitem.updated' && m.workItem.id === epicId && m.workItem.status === 'done',
      15000,
    );
  });

  it('a casual message does not spawn an epic', async () => {
    const { projectId } = await createProject();
    await addSpecialist(projectId, 'frontend-engineer');

    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chat`,
      payload: { content: 'Thanks, that looks great!' },
    });
    await ctx.waitFor((m) => m.type === 'chat.message' && m.message.role === 'agent');
    // Give any (unexpected) async decomposition a moment, then assert none happened.
    await new Promise((r) => setTimeout(r, 200));
    expect(ctx.store.listWorkItems(projectId).some((i) => i.kind === 'epic')).toBe(false);
  });
});
