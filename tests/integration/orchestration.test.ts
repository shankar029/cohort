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
  it('edits an agent via PATCH without a 500 or losing emoji/color (regression)', async () => {
    const { projectId } = await createProject();
    const agentId = await addSpecialist(projectId, 'frontend-engineer');
    const before = ctx.store.getAgent(agentId)!;

    // Mirror the editor payload: no emoji/color/tools in the body.
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}`,
      payload: {
        displayName: 'FE Renamed',
        description: 'Now with a11y',
        prompt: 'Updated persona.',
        model: 'gpt-5',
        skills: ['a11y'],
      },
    });
    expect(res.statusCode).toBe(200);
    const agent = (res.json() as { agent: { displayName: string; emoji: string; color: string } })
      .agent;
    expect(agent.displayName).toBe('FE Renamed');
    expect(agent.emoji).toBe(before.emoji); // preserved, not nulled
    expect(agent.color).toBe(before.color);
    expect(ctx.store.getAgent(agentId)!.model).toBe('gpt-5');
  });

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

  it('a work item assigned to the Team Lead is delegated to a specialist, not run by the Lead', async () => {
    const { projectId, leadId } = await createProject();
    const specialistId = await addSpecialist(projectId);

    // User hands the task to the Lead.
    const create = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workitems`,
      payload: { title: 'Build the login screen', status: 'todo', assigneeAgentId: leadId },
    });
    const item = (create.json() as { workItem: WorkItem }).workItem;
    expect(item.assigneeAgentId).toBe(leadId);

    // The Lead delegates it: it ends up reassigned to the specialist and advances.
    const reviewed = (await ctx.waitFor(
      (m) =>
        m.type === 'workitem.updated' &&
        m.workItem.id === item.id &&
        m.workItem.assigneeAgentId === specialistId &&
        m.workItem.status === 'review',
    )) as Extract<import('../../src/shared/index.js').ServerMessage, { type: 'workitem.updated' }>;
    expect(reviewed.workItem.assigneeAgentId).toBe(specialistId);

    // The Lead never executes work itself.
    const leadTasks = await ctx.app.inject({ method: 'GET', url: `/api/agents/${leadId}/tasks` });
    expect((leadTasks.json() as { tasks: AgentTask[] }).tasks).toHaveLength(0);
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
  it('the Lead escalates to the user when a decision needs a human, then resumes', async () => {
    const { projectId } = await createProject();
    const agentId = await addSpecialist(projectId);

    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workitems`,
      payload: { title: 'Ambiguous task [[ASK_USER]]', status: 'todo', assigneeAgentId: agentId },
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

  it('the Lead resolves a routine specialist question itself without pinging the user', async () => {
    const { projectId } = await createProject();
    const agentId = await addSpecialist(projectId);

    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workitems`,
      payload: { title: 'Routine task [[ASK]]', status: 'todo', assigneeAgentId: agentId },
    });

    // The Lead decides, so the task proceeds to review with no user question raised.
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
  it('the board is system-owned — an agent cannot create competing work items', async () => {
    const { projectId } = await createProject();
    const agentId = await addSpecialist(projectId);

    // The marker would have driven a create_work_item tool in the old design;
    // that capability is intentionally removed (the Team Lead owns the board).
    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workitems`,
      payload: {
        title: 'Investigate and [[CREATE_TASK: Write integration tests]]',
        status: 'todo',
        assigneeAgentId: agentId,
      },
    });

    // The agent runs its task to review, but no agent-created task appears.
    await ctx.waitFor((m) => m.type === 'workitem.updated' && m.workItem.status === 'review', 8000);
    const items = ctx.store.listWorkItems(projectId).map((i) => i.title);
    expect(items).not.toContain('Write integration tests');
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

    // The Team Lead posts a clear, user-facing plan summary in the main chat.
    await ctx.waitFor(
      (m) => m.type === 'chat.message' && m.message.content.includes('Plan for'),
      8000,
    );

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

    // The epic rolls up to 100% progress when complete, and its child tasks report
    // full progress as they finish.
    expect(ctx.store.getWorkItem(epicId)?.progress).toBe(100);
    expect(ctx.store.getWorkItem(fe.id)?.progress).toBe(100);

    // Major milestones were recorded as user notifications (epic, plan, task, merge).
    const notifTypes = new Set(ctx.store.listNotifications(projectId).map((n) => n.type));
    expect(notifTypes.has('epic')).toBe(true);
    expect(notifTypes.has('plan')).toBe(true);
    expect(notifTypes.has('task')).toBe(true);
    expect(notifTypes.has('merge')).toBe(true);
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

describe('agent task structure (sub-task checklist)', () => {
  it('a specialist splits its work item into sub-tasks and completes each', async () => {
    const { projectId } = await createProject();
    const feId = await addSpecialist(projectId, 'frontend-engineer');

    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chat`,
      payload: { content: 'Please build a profile page.' },
    });

    // Wait until the frontend task reaches review (its work is complete).
    const feTaskMsg = (await ctx.waitFor(
      (m) =>
        m.type === 'workitem.updated' &&
        m.workItem.stream === 'frontend' &&
        m.workItem.status === 'review',
      8000,
    )) as Extract<import('../../src/shared/index.js').ServerMessage, { type: 'workitem.updated' }>;
    const workItemId = feTaskMsg.workItem.id;

    // The agent planned a checklist of sub-tasks under that work item and knocked
    // each one off — including a dedicated testing sub-task.
    const subtasks = ctx.store
      .listTasks(projectId, feId)
      .filter((t: AgentTask) => t.workItemId === workItemId);
    expect(subtasks.length).toBeGreaterThanOrEqual(2);
    expect(subtasks.every((t) => t.status === 'done')).toBe(true);
    expect(subtasks.some((t) => /test/i.test(t.title))).toBe(true);
  });
});

describe('Team Lead recovers a stuck agent by restarting its session', () => {
  it('restarts the session once on an empty build, then escalates if still stuck', async () => {
    const { projectId } = await createProject();
    await addSpecialist(projectId, 'frontend-engineer');

    // [[NOOP]] flows into the task prompt so the agent narrates but writes no
    // files — the empty-build path that triggers the Lead's session restart.
    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chat`,
      payload: { content: 'Please build a broken widget [[NOOP]]' },
    });

    // First recovery: the Lead tears down the session and starts a fresh one.
    const restart = (await ctx.waitFor(
      (m) => m.type === 'notification.created' && m.notification.title.startsWith('Restarted'),
      10000,
    )) as Extract<
      import('../../src/shared/index.js').ServerMessage,
      { type: 'notification.created' }
    >;
    expect(restart.notification.type).toBe('system');

    // Still empty after the restart → the Lead escalates to the user for guidance.
    await ctx.waitFor(
      (m) => m.type === 'notification.created' && m.notification.title.startsWith('Task blocked'),
      10000,
    );
    await ctx.waitFor(
      (m) => m.type === 'question.updated' && m.question.status === 'pending',
      10000,
    );
  });
});

describe('Team Lead ownership', () => {
  it('the Lead assigns an unassigned ready item to a matching specialist', async () => {
    const { projectId } = await createProject();
    await addSpecialist(projectId, 'frontend-engineer');

    // A user drops an unassigned card in To Do; the Lead — not the agent — assigns it.
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workitems`,
      payload: { title: '[frontend] tidy the header', status: 'todo' },
    });
    expect(res.statusCode).toBe(201);
    const itemId = (res.json() as { workItem: { id: string } }).workItem.id;

    const assigned = await ctx.waitFor(
      (m) =>
        m.type === 'workitem.updated' &&
        m.workItem.id === itemId &&
        m.workItem.assigneeAgentId != null,
      5000,
    );
    expect(assigned.type === 'workitem.updated' && assigned.workItem.assigneeAgentId).toBeTruthy();
    const fe = ctx.store.listAgents(projectId).find((a) => a.name === 'frontend')!;
    expect(ctx.store.getWorkItem(itemId)?.assigneeAgentId).toBe(fe.id);
  });

  it('the Lead posts a periodic status heartbeat while an epic is active', async () => {
    const prevTick = process.env.ATEAM_LEAD_TICK_MS;
    const prevBeat = process.env.ATEAM_STATUS_HEARTBEAT_MS;
    process.env.ATEAM_LEAD_TICK_MS = '20';
    process.env.ATEAM_STATUS_HEARTBEAT_MS = '1';
    try {
      const { projectId } = await createProject();
      await addSpecialist(projectId, 'frontend-engineer');

      await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/chat`,
        payload: { content: 'Please build a settings page.' },
      });

      const status = (await ctx.waitFor(
        (m) => m.type === 'chat.message' && /Status update/.test(m.message.content),
        8000,
      )) as { type: 'chat.message'; message: { content: string } };
      expect(status.message.content).toMatch(/Status update/);
    } finally {
      if (prevTick === undefined) delete process.env.ATEAM_LEAD_TICK_MS;
      else process.env.ATEAM_LEAD_TICK_MS = prevTick;
      if (prevBeat === undefined) delete process.env.ATEAM_STATUS_HEARTBEAT_MS;
      else process.env.ATEAM_STATUS_HEARTBEAT_MS = prevBeat;
    }
  });
});
