import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestApp, rmDir, type TestApp } from '../helpers/testApp.js';
import { FakeCopilotAdapter } from '../../src/server/agents/fakeAdapter.js';
import type { AgentSession, AgentSessionConfig } from '../../src/server/agents/adapter.js';
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

describe('pause / resume', () => {
  it('pausing halts pickup; resuming lets the work advance', async () => {
    const { projectId } = await createProject();
    const agentId = await addSpecialist(projectId);

    const pause = await ctx.app.inject({ method: 'POST', url: `/api/projects/${projectId}/pause` });
    expect(pause.statusCode).toBe(200);

    const create = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workitems`,
      payload: { title: 'Paused task', status: 'todo', assigneeAgentId: agentId },
    });
    const item = (create.json() as { workItem: WorkItem }).workItem;

    // While paused it must stay put, not reach review.
    await new Promise((r) => setTimeout(r, 700));
    expect(ctx.store.getWorkItem(item.id)!.status).not.toBe('review');

    // Resume: the assigned work now advances autonomously.
    const resume = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/resume`,
    });
    expect(resume.statusCode).toBe(200);
    await ctx.waitFor(
      (m) =>
        m.type === 'workitem.updated' &&
        m.workItem.id === item.id &&
        m.workItem.status === 'review',
      8000,
    );
  });
});

describe('board-created epics', () => {
  it('creating an epic on the board is Lead-owned and decomposed into specialist tasks', async () => {
    const { projectId, leadId } = await createProject();
    await addSpecialist(projectId, 'frontend-engineer');

    const create = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workitems`,
      payload: { title: 'Checkout redesign', description: 'Build a new checkout', kind: 'epic' },
    });
    expect(create.statusCode).toBe(201);
    const epic = (create.json() as { workItem: WorkItem }).workItem;
    expect(epic.kind).toBe('epic');

    const child = (await ctx.waitFor(
      (m) =>
        m.type === 'workitem.updated' &&
        m.workItem.parentId === epic.id &&
        m.workItem.kind === 'task',
      8000,
    )) as Extract<import('../../src/shared/index.js').ServerMessage, { type: 'workitem.updated' }>;
    expect(child.workItem.parentId).toBe(epic.id);
    expect(ctx.store.getWorkItem(epic.id)!.assigneeAgentId).toBe(leadId);
  });

  it('rejects reassigning an epic away from the Team Lead', async () => {
    const { projectId } = await createProject();
    const specialistId = await addSpecialist(projectId);
    const create = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workitems`,
      payload: { title: 'Owned epic', kind: 'epic' },
    });
    const epic = (create.json() as { workItem: WorkItem }).workItem;

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/workitems/${epic.id}`,
      payload: { assigneeAgentId: specialistId },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('standalone task deliverable gate', () => {
  it('a standalone task that writes no files is gated, not silently completed', async () => {
    const { projectId } = await createProject();
    const agentId = await addSpecialist(projectId, 'frontend-engineer');
    // Narrate-only persona: the agent reports progress but writes no files.
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}`,
      payload: { prompt: 'You build UI. [[NOOP]]' },
    });

    const create = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workitems`,
      payload: { title: 'Add a settings page', status: 'todo', assigneeAgentId: agentId },
    });
    const item = (create.json() as { workItem: WorkItem }).workItem;

    // The empty-build gate fires instead of accepting a fabricated "done".
    await ctx.waitFor(
      (m) => m.type === 'event.appended' && /Produced no file changes/i.test(m.event.summary),
      10000,
    );
    expect(ctx.store.getWorkItem(item.id)!.status).not.toBe('review');
  });

  it('a standalone task that writes real files advances to review', async () => {
    const { projectId } = await createProject();
    const agentId = await addSpecialist(projectId, 'frontend-engineer');

    const create = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workitems`,
      payload: { title: 'Add a settings page', status: 'todo', assigneeAgentId: agentId },
    });
    const item = (create.json() as { workItem: WorkItem }).workItem;

    await ctx.waitFor(
      (m) =>
        m.type === 'workitem.updated' &&
        m.workItem.id === item.id &&
        m.workItem.status === 'review',
      10000,
    );
    // Real deliverable files were written into the project checkout.
    expect(fs.existsSync(path.join(repoDir, 'deliverables'))).toBe(true);
  });
});

describe('Lead delegation picks the best-fit specialist', () => {
  it('routes a user-assigned task to the inferred stream, not an arbitrary specialist', async () => {
    const { projectId, leadId } = await createProject('Delegation');
    // UX is added FIRST so the old load-based fallback would have dumped the task
    // on it; a frontend engineer is the correct target for a web-page task.
    await addSpecialist(projectId, 'ux-designer');
    const feId = await addSpecialist(projectId, 'frontend-engineer');

    // A standalone task with no stream, handed to the Team Lead to delegate.
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workitems`,
      payload: {
        kind: 'task',
        title: 'Build the tip calculator web page',
        description: 'Frontend: index.html + styles.css, responsive layout.',
        status: 'todo',
        assigneeAgentId: leadId,
      },
    });
    expect(created.statusCode).toBe(201);
    const itemId = (created.json() as { workItem: { id: string } }).workItem.id;

    // The Lead delegates it to the frontend engineer (inferred), never UX.
    await ctx.waitFor(
      (m) =>
        m.type === 'workitem.updated' &&
        m.workItem.id === itemId &&
        m.workItem.assigneeAgentId === feId,
      15000,
    );
  });
});

describe('per-epic threads', () => {
  it('gives each epic its own thread and routes the epic discussion into it', async () => {
    const { projectId } = await createProject('EpicThreads');
    await addSpecialist(projectId, 'frontend-engineer');

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workitems`,
      payload: {
        kind: 'epic',
        title: 'Trip Calculator',
        description: 'Build a trip cost splitter web page.',
      },
    });
    expect(res.statusCode).toBe(201);
    const epicId = (res.json() as { workItem: { id: string } }).workItem.id;

    // A dedicated group thread is created for the epic (workItemId === epic).
    const evt = await ctx.waitFor(
      (m) =>
        m.type === 'thread.updated' && m.thread.kind === 'group' && m.thread.workItemId === epicId,
      15000,
    );
    const epicThreadId = evt.type === 'thread.updated' ? evt.thread.id : '';
    expect(epicThreadId).toBeTruthy();

    // The epic's discussion lands in that thread, not the main channel.
    await ctx.waitFor(
      (m) => m.type === 'chat.message' && m.message.threadId === epicThreadId,
      15000,
    );
    const main = ctx.store.ensureMainThread(projectId);
    expect(main.id).not.toBe(epicThreadId);
  });
});

describe('usage tracking', () => {
  it('records time + tokens per agent as work is done, and rolls up per work item', async () => {
    const { projectId } = await createProject('UsageTrack');
    await addSpecialist(projectId, 'frontend-engineer');

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/workitems`,
      payload: { kind: 'epic', title: 'Usage Epic', description: 'Build a small widget.' },
    });
    const epicId = (res.json() as { workItem: { id: string } }).workItem.id;

    // Usage is broadcast live as agents take turns.
    const evt = await ctx.waitFor(
      (m) => m.type === 'usage.updated' && m.entry.inputTokens + m.entry.outputTokens > 0,
      15000,
    );
    expect(evt.type === 'usage.updated' && evt.entry.timeMs).toBeGreaterThanOrEqual(0);

    // Give the epic a moment to fan out to the specialist, then wait until at
    // least one turn has COMPLETED (wall-clock time is recorded in runTurn's
    // finally, after the turn ends) before asserting the ledger.
    await ctx.waitFor(
      (m) => m.type === 'workitem.updated' && m.workItem.parentId === epicId,
      15000,
    );
    await ctx.waitFor((m) => m.type === 'usage.updated' && m.entry.timeMs > 0, 15000);
    const ledger = ctx.store.listUsage(projectId);
    expect(ledger.length).toBeGreaterThan(0);
    const totalTokens = ledger.reduce((s, u) => s + u.inputTokens + u.outputTokens, 0);
    const totalTime = ledger.reduce((s, u) => s + u.timeMs, 0);
    expect(totalTokens).toBeGreaterThan(0);
    expect(totalTime).toBeGreaterThan(0);
  });
});

describe('Team Lead robustness (self-healing manager)', () => {
  it('closes an epic whose children all landed but was left in_progress — from the periodic tick alone', async () => {
    const prevTick = process.env.ATEAM_LEAD_TICK_MS;
    process.env.ATEAM_LEAD_TICK_MS = '20';
    try {
      const { projectId } = await createProject('SelfHeal');
      await addSpecialist(projectId, 'frontend-engineer');
      await addSpecialist(projectId, 'qa-engineer');

      // Fabricate a stuck state directly in the store: an epic still in_progress
      // whose child tasks are all done, WITHOUT ever firing the task-completion
      // event that normally triggers closure. Only the periodic manager sweep can
      // rescue this.
      const epic = ctx.store.createWorkItem({
        projectId,
        kind: 'epic',
        title: 'Stuck Epic',
        description: 'All work done but never closed.',
        status: 'in_progress',
        priority: 'medium',
        assigneeAgentId: null,
      });
      for (const t of ['a', 'b']) {
        ctx.store.createWorkItem({
          projectId,
          kind: 'task',
          parentId: epic.id,
          title: `task ${t}`,
          description: 'done',
          status: 'done',
          priority: 'medium',
          assigneeAgentId: null,
        });
      }

      // Arm the project's manager loop (project creation alone doesn't construct
      // the orchestrator). A read-only git snapshot is enough to spin it up.
      await ctx.app.inject({ method: 'GET', url: `/api/projects/${projectId}/git` });

      // The manager sweep drives it to closure without any user poke.
      await ctx.waitFor(
        (m) =>
          m.type === 'workitem.updated' &&
          m.workItem.id === epic.id &&
          m.workItem.status === 'done',
        8000,
      );
      expect(ctx.store.getWorkItem(epic.id)?.status).toBe('done');
    } finally {
      if (prevTick === undefined) delete process.env.ATEAM_LEAD_TICK_MS;
      else process.env.ATEAM_LEAD_TICK_MS = prevTick;
    }
  });

  it('proactively flags a stalled project that has work but no specialists to do it', async () => {
    const prevTick = process.env.ATEAM_LEAD_TICK_MS;
    const prevStall = process.env.ATEAM_STALL_MS;
    process.env.ATEAM_LEAD_TICK_MS = '20';
    process.env.ATEAM_STALL_MS = '1';
    try {
      const { projectId } = await createProject('Stalled');
      // No specialists added — the Lead cannot self-heal. Creating the task via the
      // API arms the manager loop (and pokes the Lead) for an unassigned todo item.
      await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/workitems`,
        payload: { title: 'Orphan task', description: 'Nobody to build this.', status: 'todo' },
      });

      const msg = (await ctx.waitFor(
        (m) => m.type === 'chat.message' && /stalled work/i.test(m.message.content),
        8000,
      )) as { type: 'chat.message'; message: { content: string } };
      expect(msg.message.content).toMatch(/no specialists/i);

      // And the user is notified so they don't have to discover it themselves.
      await ctx.waitFor(
        (m) => m.type === 'notification.created' && /blocked/i.test(m.notification.title),
        8000,
      );
    } finally {
      if (prevTick === undefined) delete process.env.ATEAM_LEAD_TICK_MS;
      else process.env.ATEAM_LEAD_TICK_MS = prevTick;
      if (prevStall === undefined) delete process.env.ATEAM_STALL_MS;
      else process.env.ATEAM_STALL_MS = prevStall;
    }
  });
});

describe('user-started Team Lead threads', () => {
  it('creates a new conversation and routes chat to it (not main), auto-titling from the first message', async () => {
    const { projectId } = await createProject('Threads');

    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/threads`,
      payload: {},
    });
    expect(created.statusCode).toBe(201);
    const thread = (created.json() as { thread: { id: string; kind: string; topic: string } })
      .thread;
    expect(thread.kind).toBe('dm');

    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chat`,
      payload: { content: 'Lets talk about analytics dashboards', threadId: thread.id },
    });

    // The Lead replies in the NEW thread, not the main channel.
    const reply = (await ctx.waitFor(
      (m) =>
        m.type === 'chat.message' && m.message.threadId === thread.id && m.message.role !== 'user',
      8000,
    )) as { type: 'chat.message'; message: { threadId: string } };
    expect(reply.message.threadId).toBe(thread.id);

    // The user message landed in the new thread and it was auto-titled.
    const msgs = ctx.store.listThreadMessages(thread.id);
    expect(msgs.some((m) => m.role === 'user' && /analytics dashboards/.test(m.content))).toBe(
      true,
    );
    const main = ctx.store.ensureMainThread(projectId);
    expect(ctx.store.listThreadMessages(main.id).length).toBe(0);
    expect(ctx.store.getThread(thread.id)?.topic).toMatch(/analytics dashboards/i);
  });
});

describe('epic decomposition delegates to specialists', () => {
  it('assigns stream tasks to specialists (not the Lead) even when the request is a pasted spec, and titles it sensibly', async () => {
    const { projectId, leadId } = await createProject('Delegation');
    await addSpecialist(projectId, 'frontend-engineer');
    await addSpecialist(projectId, 'backend-engineer');

    // A pasted requirement whose first lines are markdown section headers.
    const spec = [
      '## 1. Summary / goal',
      '',
      'Build a settings page so users can change their profile and preferences.',
      '',
      '## 2. Scope',
      '- profile form',
    ].join('\n');

    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chat`,
      payload: { content: spec },
    });

    // The decomposition creates child tasks assigned to specialists.
    await ctx.waitFor(
      (m) =>
        m.type === 'workitem.updated' &&
        m.workItem.kind === 'task' &&
        !!m.workItem.parentId &&
        !!m.workItem.assigneeAgentId &&
        m.workItem.assigneeAgentId !== leadId,
      8000,
    );

    const items = ctx.store.listWorkItems(projectId);
    const epic = items.find((i) => i.kind === 'epic')!;
    // Title is a real goal, not the bare section header.
    expect(epic.title.toLowerCase()).not.toMatch(/^summary/);
    expect(epic.title.toLowerCase()).not.toContain('summary / goal');
    expect(epic.title.toLowerCase()).toContain('settings page');

    // Children exist and are owned by specialists, not the Lead.
    const kids = items.filter((i) => i.parentId === epic.id && i.kind === 'task');
    expect(kids.length).toBeGreaterThan(0);
    const builderKids = kids.filter((k) => k.stream === 'frontend' || k.stream === 'backend');
    expect(builderKids.length).toBeGreaterThan(0);
    expect(builderKids.every((k) => k.assigneeAgentId && k.assigneeAgentId !== leadId)).toBe(true);
  });
});

/** A fake adapter that records every prompt sent to any agent session, so a test
 *  can assert what a builder actually received. Keeps name='fake' so gating is
 *  unchanged. */
class RecordingAdapter extends FakeCopilotAdapter {
  readonly prompts: string[] = [];
  override async createAgentSession(config: AgentSessionConfig): Promise<AgentSession> {
    const session = await super.createAgentSession(config);
    const original = session.ask.bind(session);
    session.ask = async (prompt: string, messageId: string): Promise<string> => {
      this.prompts.push(prompt);
      return original(prompt, messageId);
    };
    return session;
  }
}

describe('epic design is injected into builder prompts', () => {
  it('persists the Architect design and feeds it into a builder run prompt', async () => {
    const adapter = new RecordingAdapter();
    await ctx.close();
    ctx = createTestApp([], adapter);

    const { projectId } = await createProject('DesignInjection');
    await addSpecialist(projectId, 'architect');
    await addSpecialist(projectId, 'frontend-engineer');
    await addSpecialist(projectId, 'backend-engineer');

    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chat`,
      payload: { content: 'Build a small dashboard widget with a REST endpoint.' },
    });

    // Wait for decomposition to create specialist tasks.
    await ctx.waitFor(
      (m) =>
        m.type === 'workitem.updated' &&
        m.workItem.kind === 'task' &&
        !!m.workItem.parentId &&
        !!m.workItem.assigneeAgentId,
      8000,
    );
    const epic = ctx.store.listWorkItems(projectId).find((i) => i.kind === 'epic')!;

    // The Architect's best-effort design turn (step 5b) persists a design row.
    const deadline = Date.now() + 8000;
    while (!ctx.store.getEpicDesign(epic.id) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(ctx.store.getEpicDesign(epic.id).length).toBeGreaterThan(0);

    // Once the design exists, at least one builder's run prompt must carry it.
    const injected = Date.now() + 8000;
    while (
      !adapter.prompts.some((p) => p.includes('# Epic technical design')) &&
      Date.now() < injected
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(adapter.prompts.some((p) => p.includes('# Epic technical design'))).toBe(true);
  });
});

describe('epic acceptance criteria are persisted from the PM', () => {
  it('parses the PM AC: lines into records and exposes them via the API', async () => {
    const { projectId } = await createProject('Criteria');
    await addSpecialist(projectId, 'product-manager');
    await addSpecialist(projectId, 'frontend-engineer');

    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chat`,
      payload: { content: 'Build a small dashboard widget.' },
    });

    // The PM's best-effort turn (step 5b) persists structured criteria and the
    // server broadcasts them.
    const msg = (await ctx.waitFor(
      (m) => m.type === 'criteria.updated' && m.criteria.length > 0,
      8000,
    )) as Extract<import('../../src/shared/index.js').ServerMessage, { type: 'criteria.updated' }>;
    const epicId = msg.epicId;
    expect(msg.criteria.every((c) => c.status === 'open' && c.epicId === epicId)).toBe(true);

    // Persisted and readable via the API.
    const stored = ctx.store.listCriteria(epicId);
    expect(stored.length).toBeGreaterThanOrEqual(2);

    const res = await ctx.app.inject({ method: 'GET', url: `/api/workitems/${epicId}/criteria` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { criteria: Array<{ text: string }> };
    expect(body.criteria.length).toBe(stored.length);
    // The parsed text is the criterion only (the `AC:` prefix is stripped).
    expect(body.criteria.every((c) => !/^AC:/i.test(c.text))).toBe(true);
  });
});

describe('epic dependency-graph safety', () => {
  it('repairs a malformed dependency graph so the epic never stalls', async () => {
    const prevTick = process.env.ATEAM_LEAD_TICK_MS;
    process.env.ATEAM_LEAD_TICK_MS = '30';
    try {
      const { projectId } = await createProject('DagSafety');
      await addSpecialist(projectId, 'frontend-engineer');
      await addSpecialist(projectId, 'backend-engineer');

      // The instant two sibling tasks exist, inject a mutual cycle AND park them
      // (backlog + unassigned) so the epic cannot finish until the graph is
      // repaired. Without the sanitize pass both tasks would wait on each other
      // forever.
      let injected = false;
      const unsub = ctx.bus.subscribe((m) => {
        if (injected) return;
        if (m.type !== 'workitem.updated' || m.workItem.kind !== 'task' || !m.workItem.parentId)
          return;
        const sibs = ctx.store.listChildTasks(m.workItem.parentId);
        if (sibs.length < 2) return;
        injected = true;
        const [a, b] = sibs;
        ctx.store.updateWorkItem(a!.id, {
          dependsOn: [b!.id],
          status: 'backlog',
          assigneeAgentId: null,
        });
        ctx.store.updateWorkItem(b!.id, {
          dependsOn: [a!.id],
          status: 'backlog',
          assigneeAgentId: null,
        });
      });

      await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/chat`,
        payload: { content: 'Please build a profile page.' },
      });

      // The graph is repaired...
      const repaired = await ctx.waitFor(
        (m) =>
          m.type === 'event.appended' &&
          /Repaired \d+ invalid dependency edge/.test(m.event.summary),
        20000,
      );
      expect(repaired).toBeTruthy();

      // ...and the epic still reaches done rather than deadlocking.
      await ctx.waitFor(
        (m) =>
          m.type === 'workitem.updated' &&
          m.workItem.kind === 'epic' &&
          m.workItem.status === 'done',
        25000,
      );
      unsub();
    } finally {
      if (prevTick === undefined) delete process.env.ATEAM_LEAD_TICK_MS;
      else process.env.ATEAM_LEAD_TICK_MS = prevTick;
    }
  });
});

describe('dispatch resilience', () => {
  it('materializes the board even when the Lead chat reply rat-holes (Fix A/B)', async () => {
    // An adapter whose Lead conversational-reply turn never returns within the
    // test window — simulating a reply that loops on a stray built-in tool (the
    // real-SDK `sql`/session-store failure we observed). Dispatch must not wait
    // on it: the board is materialized in code, not by the chat turn.
    class HangingLeadReplyAdapter extends FakeCopilotAdapter {
      override async createAgentSession(config: AgentSessionConfig): Promise<AgentSession> {
        const session = await super.createAgentSession(config);
        if (config.role !== 'lead') return session;
        const orig = session.ask.bind(session);
        session.ask = async (prompt: string, messageId: string): Promise<string> => {
          if (/Respond to the user/.test(prompt)) {
            await new Promise<void>((r) => {
              const t = setTimeout(r, 30_000);
              (t as { unref?: () => void }).unref?.();
            });
            return '';
          }
          return orig(prompt, messageId);
        };
        return session;
      }
    }

    const app2 = createTestApp([], new HangingLeadReplyAdapter());
    try {
      const res = await app2.app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Hang', repoDir },
      });
      const projectId = (res.json() as { project: { id: string } }).project.id;
      for (const catalogId of ['backend-engineer', 'qa-engineer']) {
        await app2.app.inject({
          method: 'POST',
          url: `/api/projects/${projectId}/agents`,
          payload: { catalogId },
        });
      }

      // Build-intent message: the Lead's reply hangs, but a real task card must
      // still land on the board (code-driven decompose).
      await app2.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/chat`,
        payload: { content: 'Build a small URL shortener service' },
      });

      const msg = await app2.waitFor(
        (m) =>
          m.type === 'workitem.updated' &&
          m.workItem.kind === 'task' &&
          m.workItem.projectId === projectId,
        8000,
      );
      expect(msg.type).toBe('workitem.updated');
    } finally {
      await app2.close();
    }
  });
});

describe('stream scoping (I1/I6)', () => {
  it('does not spawn ux/frontend/researcher tasks for a headless API request', async () => {
    const { projectId } = await createProject();
    for (const catalogId of [
      'backend-engineer',
      'frontend-engineer',
      'ux-designer',
      'researcher',
      'qa-engineer',
    ]) {
      await addSpecialist(projectId, catalogId);
    }

    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chat`,
      payload: {
        content:
          'Build an in-memory URL shortener using only Node built-in http, no external ' +
          'dependencies. Expose POST /shorten and GET /:code. Headless API only, no UI.',
      },
    });

    // Wait for the backend task to land, then let the fan-out settle.
    await ctx.waitFor(
      (m) =>
        m.type === 'workitem.updated' &&
        m.workItem.kind === 'task' &&
        m.workItem.stream === 'backend',
      8000,
    );
    await new Promise((r) => setTimeout(r, 400));

    const epic = ctx.store.listWorkItems(projectId).find((w) => w.kind === 'epic');
    expect(epic).toBeTruthy();
    const streams = new Set(ctx.store.listChildTasks(epic!.id).map((t) => t.stream ?? ''));
    expect(streams.has('backend')).toBe(true);
    expect(streams.has('ux')).toBe(false);
    expect(streams.has('frontend')).toBe(false);
    expect(streams.has('researcher')).toBe(false);
  });
});
