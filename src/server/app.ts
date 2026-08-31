import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z, ZodError } from 'zod';
import type { Store } from './db/store.js';
import type { Bus } from './bus.js';
import type { OrchestratorManager } from './orchestrator.js';
import type { SessionRecorder } from './sessionRecorder.js';
import {
  answerQuestionSchema,
  createAgentSchema,
  createProjectSchema,
  createWorkItemSchema,
  sendChatSchema,
  createThreadSchema,
  uploadFileSchema,
  updateAgentSchema,
  updateProjectSettingsSchema,
  updateWorkItemSchema,
} from '@shared/index';
import { AGENT_CATALOG, createAgent, createProjectWithLead, validateRepoDir } from './services.js';
import { discoverSkills } from './agents/skillScanner.js';

export interface AppContext {
  store: Store;
  bus: Bus;
  orchestrators: OrchestratorManager;
  recorder: SessionRecorder;
  config: { defaultModel: string; skillHomeRoots: string[] };
  listModels: () => Promise<string[]>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface DirEntry {
  name: string;
  path: string;
}
export interface DirListing {
  path: string | null;
  parent: string | null;
  entries: DirEntry[];
}

/** List sub-directories of `dir` for the folder picker. No `dir` → roots (drives/home). */
export function listDirs(dir?: string): DirListing {
  // Roots: on Windows the available drive letters; elsewhere the home directory.
  if (!dir) {
    if (process.platform === 'win32') {
      const drives: DirEntry[] = [];
      for (let c = 65; c <= 90; c++) {
        const root = `${String.fromCharCode(c)}:\\`;
        try {
          if (fs.existsSync(root)) drives.push({ name: root, path: root });
        } catch {
          /* skip unreadable drive */
        }
      }
      const home = os.homedir();
      return {
        path: null,
        parent: null,
        entries: [{ name: `~ (${home})`, path: home }, ...drives],
      };
    }
    const home = os.homedir();
    return { path: null, parent: null, entries: [{ name: `~ (${home})`, path: home }] };
  }

  const abs = path.resolve(dir);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new HttpError(400, `Cannot open: ${abs}`);
  }
  if (!stat.isDirectory()) throw new HttpError(400, `Not a directory: ${abs}`);

  let names: string[] = [];
  try {
    names = fs.readdirSync(abs);
  } catch {
    throw new HttpError(400, `Cannot read: ${abs}`);
  }
  const entries: DirEntry[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue; // hide dotfiles/dirs by default
    const full = path.join(abs, name);
    try {
      if (fs.statSync(full).isDirectory()) entries.push({ name, path: full });
    } catch {
      /* unreadable entry — skip */
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const parentPath = path.dirname(abs);
  const parent = parentPath === abs ? null : parentPath; // null at a filesystem root
  return { path: abs, parent, entries };
}

export function buildApp(ctx: AppContext): FastifyInstance {
  const app = Fastify({ logger: false });
  const { store, bus, orchestrators, recorder, config } = ctx;

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof ZodError) {
      reply.status(400).send({ error: 'Validation failed', details: err.flatten() });
      return;
    }
    if (err instanceof HttpError) {
      reply.status(err.status).send({ error: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : 'Internal error';
    reply.status(500).send({ error: message || 'Internal error' });
  });

  const requireProject = (id: string) => {
    const p = store.getProject(id);
    if (!p) throw new HttpError(404, 'Project not found');
    return p;
  };

  app.get('/api/health', async () => ({ ok: true }));

  /* --------------------------------------------------------------- models */
  app.get('/api/models', async () => {
    try {
      const models = await ctx.listModels();
      return { models: models.length ? models : [config.defaultModel] };
    } catch {
      return { models: [config.defaultModel] };
    }
  });

  /* ----------------------------------------------------------- filesystem */
  // Directory browser for the "choose folder" picker when creating a project.
  // This is a LOCAL app — the server and the user share one machine — so listing
  // directories on that machine is expected and safe.
  app.get('/api/fs/dirs', async (req) => {
    const raw = (req.query as { path?: string }).path;
    return listDirs(raw && raw.trim() ? raw.trim() : undefined);
  });

  /* -------------------------------------------------------------- catalog */
  app.get('/api/catalog', async () => ({ agents: AGENT_CATALOG }));

  /* ------------------------------------------------------------- projects */
  app.get('/api/projects', async () => ({ projects: store.listProjects() }));

  app.post('/api/projects', async (req, reply) => {
    const input = createProjectSchema.parse(req.body);
    const check = validateRepoDir(input.repoDir);
    if (!check.ok) throw new HttpError(400, check.error);
    const project = createProjectWithLead(store, config, input, check.resolved);
    bus.publish({ type: 'project.updated', project });
    reply.status(201);
    return { project, agents: store.listAgents(project.id) };
  });

  app.get('/api/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    const project = requireProject(id);
    return {
      project,
      agents: store.listAgents(id),
      workItems: store.listWorkItems(id),
      questions: store.listQuestions(id),
      threads: store.listThreads(id),
      pulls: store.listPRs(id),
      prComments: store.listProjectPrComments(id),
      notifications: store.listNotifications(id),
      usage: store.listUsage(id),
    };
  });

  app.patch('/api/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    const project = requireProject(id);
    const input = updateProjectSettingsSchema.parse(req.body);
    const updated = store.updateProject(id, {
      name: input.name,
      settings: {
        defaultModel: input.defaultModel ?? project.settings.defaultModel,
        approvalMode: input.approvalMode ?? project.settings.approvalMode,
        extraSkillRoots: input.extraSkillRoots ?? project.settings.extraSkillRoots,
        paused: project.settings.paused,
        recordSessions: input.recordSessions ?? project.settings.recordSessions,
        testCommand: input.testCommand ?? project.settings.testCommand,
        buildCommand: input.buildCommand ?? project.settings.buildCommand,
      },
    });
    if (updated) {
      bus.publish({ type: 'project.updated', project: updated });
      await orchestrators.invalidate(id);
    }
    return { project: updated };
  });

  app.post('/api/projects/:id/pause', async (req) => {
    const { id } = req.params as { id: string };
    requireProject(id);
    await orchestrators.get(id).setPaused(true);
    return { project: store.getProject(id) };
  });

  app.post('/api/projects/:id/resume', async (req) => {
    const { id } = req.params as { id: string };
    requireProject(id);
    void orchestrators
      .get(id)
      .setPaused(false)
      .catch(() => undefined);
    return { project: store.getProject(id) };
  });

  /* ------------------------------------------------------- recordings */
  app.get('/api/projects/:id/recordings', async (req) => {
    const { id } = req.params as { id: string };
    const project = requireProject(id);
    return {
      enabled: project.settings.recordSessions === true,
      recordings: recorder.list(id),
    };
  });

  app.get('/api/projects/:id/recordings/export.jsonl', async (req, reply) => {
    const { id } = req.params as { id: string };
    requireProject(id);
    reply
      .header('Content-Type', 'application/x-ndjson')
      .header('Content-Disposition', `attachment; filename="recordings-${id}.jsonl"`);
    return recorder.rawJsonl(id);
  });

  app.get('/api/projects/:id/recordings/export.md', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = requireProject(id);
    reply
      .header('Content-Type', 'text/markdown; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="recordings-${id}.md"`);
    return recorder.markdown(id, project.name);
  });

  app.get('/api/projects/:id/recordings/:turnId', async (req) => {
    const { id, turnId } = req.params as { id: string; turnId: string };
    requireProject(id);
    const turn = recorder.get(id, turnId);
    if (!turn) throw new HttpError(404, 'Recording not found');
    return { recording: turn };
  });

  app.delete('/api/projects/:id/recordings', async (req) => {
    const { id } = req.params as { id: string };
    requireProject(id);
    recorder.clear(id);
    return { ok: true };
  });

  app.delete('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    requireProject(id);
    await orchestrators.remove(id);
    store.deleteProject(id);
    bus.publish({ type: 'project.deleted', projectId: id });
    reply.status(204);
  });

  /* --------------------------------------------------------------- threads */
  app.get('/api/projects/:id/threads', async (req) => {
    const { id } = req.params as { id: string };
    requireProject(id);
    return { threads: store.listThreads(id) };
  });

  app.get('/api/threads/:threadId/messages', async (req) => {
    const { threadId } = req.params as { threadId: string };
    const thread = store.getThread(threadId);
    if (!thread) throw new HttpError(404, 'Thread not found');
    return { thread, messages: store.listThreadMessages(threadId) };
  });

  app.get('/api/projects/:id/pulls', async (req) => {
    const { id } = req.params as { id: string };
    requireProject(id);
    return { pulls: store.listPRs(id) };
  });

  app.get('/api/projects/:id/pr-comments', async (req) => {
    const { id } = req.params as { id: string };
    requireProject(id);
    return { prComments: store.listProjectPrComments(id) };
  });

  app.get('/api/workitems/:workItemId/criteria', async (req) => {
    const { workItemId } = req.params as { workItemId: string };
    return { criteria: store.listCriteria(workItemId) };
  });

  app.get('/api/workitems/:workItemId/verification', async (req) => {
    const { workItemId } = req.params as { workItemId: string };
    return {
      latest: store.latestVerification(workItemId),
      history: store.listVerification(workItemId),
    };
  });

  app.get('/api/workitems/:workItemId/metrics', async (req) => {
    const { workItemId } = req.params as { workItemId: string };
    return { metrics: store.getEpicMetrics(workItemId) ?? null };
  });

  app.get('/api/projects/:id/metrics', async (req) => {
    const { id } = req.params as { id: string };
    requireProject(id);
    return { metrics: store.listEpicMetrics(id) };
  });

  app.get('/api/projects/:id/verification', async (req) => {
    const { id } = req.params as { id: string };
    requireProject(id);
    const limit = Number((req.query as { limit?: string }).limit ?? 200);
    return { reports: store.listProjectVerification(id, limit) };
  });

  app.get('/api/projects/:id/git', async (req) => {
    const { id } = req.params as { id: string };
    requireProject(id);
    return { snapshot: await orchestrators.get(id).gitSnapshot() };
  });

  /* --------------------------------------------------------------- skills */
  app.get('/api/projects/:id/skills', async (req) => {
    const { id } = req.params as { id: string };
    const project = requireProject(id);
    return {
      skills: discoverSkills(
        config.skillHomeRoots,
        project.repoDir,
        project.settings.extraSkillRoots,
      ),
    };
  });

  /* --------------------------------------------------------------- agents */
  app.get('/api/projects/:id/agents', async (req) => {
    const { id } = req.params as { id: string };
    requireProject(id);
    return { agents: store.listAgents(id) };
  });

  app.post('/api/projects/:id/agents', async (req, reply) => {
    const { id } = req.params as { id: string };
    requireProject(id);
    const input = createAgentSchema.parse(req.body);
    if (input.catalogId && store.listAgents(id).some((a) => a.catalogId === input.catalogId))
      throw new HttpError(409, 'That agent is already on the team');
    const agent = createAgent(store, config, id, input);
    bus.publish({ type: 'agent.updated', projectId: id, agent });
    await orchestrators.invalidate(id);
    reply.status(201);
    return { agent };
  });

  app.patch('/api/agents/:agentId', async (req) => {
    const { agentId } = req.params as { agentId: string };
    const existing = store.getAgent(agentId);
    if (!existing) throw new HttpError(404, 'Agent not found');
    const input = updateAgentSchema.parse(req.body);
    const agent = store.updateAgent(agentId, {
      displayName: input.displayName,
      description: input.description,
      prompt: input.prompt,
      tools: input.tools,
      skills: input.skills,
      model: input.model,
      emoji: input.emoji,
      color: input.color,
    });
    if (agent) {
      bus.publish({ type: 'agent.updated', projectId: existing.projectId, agent });
      await orchestrators.invalidate(existing.projectId);
    }
    return { agent };
  });

  app.delete('/api/agents/:agentId', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const existing = store.getAgent(agentId);
    if (!existing) throw new HttpError(404, 'Agent not found');
    if (existing.kind === 'lead') throw new HttpError(400, 'Cannot delete the Team Lead');
    store.deleteAgent(agentId);
    await orchestrators.invalidate(existing.projectId);
    reply.status(204);
  });

  app.get('/api/agents/:agentId/tasks', async (req) => {
    const { agentId } = req.params as { agentId: string };
    const existing = store.getAgent(agentId);
    if (!existing) throw new HttpError(404, 'Agent not found');
    return { tasks: store.listTasks(existing.projectId, agentId) };
  });

  app.get('/api/agents/:agentId/notes', async (req) => {
    const { agentId } = req.params as { agentId: string };
    const existing = store.getAgent(agentId);
    if (!existing) throw new HttpError(404, 'Agent not found');
    return { plan: store.getPlan(agentId), notes: store.listNotes(agentId) };
  });

  app.get('/api/agents/:agentId/events', async (req) => {
    const { agentId } = req.params as { agentId: string };
    const existing = store.getAgent(agentId);
    if (!existing) throw new HttpError(404, 'Agent not found');
    return { events: store.listEvents(existing.projectId, { agentId }) };
  });

  /* ------------------------------------------------------------ work items */
  app.get('/api/projects/:id/workitems', async (req) => {
    const { id } = req.params as { id: string };
    requireProject(id);
    return { workItems: store.listWorkItems(id) };
  });

  app.post('/api/projects/:id/workitems', async (req, reply) => {
    const { id } = req.params as { id: string };
    requireProject(id);
    const input = createWorkItemSchema.parse(req.body);

    // An epic is always owned + planned by the Team Lead: create it, then let the
    // orchestrator force Lead ownership and decompose it (deferred while paused).
    if (input.kind === 'epic') {
      const epic = store.createWorkItem({
        projectId: id,
        kind: 'epic',
        title: input.title,
        description: input.description ?? '',
        status: 'in_progress',
        priority: input.priority ?? 'medium',
        assigneeAgentId: null,
      });
      bus.publish({ type: 'workitem.updated', projectId: id, workItem: epic });
      reply.status(201);
      void orchestrators
        .get(id)
        .onEpicCreated(epic.id)
        .catch(() => undefined);
      return { workItem: store.getWorkItem(epic.id) ?? epic };
    }

    const scheduled = typeof input.scheduledAt === 'number';
    const item = store.createWorkItem({
      projectId: id,
      title: input.title,
      description: input.description ?? '',
      // A scheduled item waits in backlog until its time arrives.
      status: scheduled ? 'backlog' : (input.status ?? 'backlog'),
      priority: input.priority ?? 'medium',
      assigneeAgentId: input.assigneeAgentId ?? null,
      scheduledAt: input.scheduledAt ?? null,
      recurrence: input.recurrence ?? 'none',
    });
    bus.publish({ type: 'workitem.updated', projectId: id, workItem: item });
    reply.status(201);
    if (scheduled) {
      orchestrators.get(id).scheduleWorkItem(item);
    } else if (item.assigneeAgentId) {
      void orchestrators
        .get(id)
        .onItemAssigned(item.id)
        .catch(() => undefined);
    } else if (item.status === 'todo') {
      // Unassigned ready work: let the Team Lead assign it.
      orchestrators.get(id).pokeLead();
    }
    return { workItem: item };
  });

  app.patch('/api/workitems/:workItemId', async (req) => {
    const { workItemId } = req.params as { workItemId: string };
    const existing = store.getWorkItem(workItemId);
    if (!existing) throw new HttpError(404, 'Work item not found');
    const input = updateWorkItemSchema.parse(req.body);
    // Epics are owned only by the Team Lead — never let one be reassigned away.
    if (existing.kind === 'epic' && input.assigneeAgentId !== undefined) {
      const lead = store.listAgents(existing.projectId).find((a) => a.kind === 'lead');
      if (input.assigneeAgentId !== (lead?.id ?? null)) {
        throw new HttpError(400, 'Epics are owned by the Team Lead and cannot be reassigned');
      }
    }
    const item = store.updateWorkItem(workItemId, input);
    if (item) {
      bus.publish({ type: 'workitem.updated', projectId: existing.projectId, workItem: item });
      const assignedNow =
        item.assigneeAgentId && (item.status === 'backlog' || item.status === 'todo');
      const changed = input.assigneeAgentId !== undefined || input.status !== undefined;
      if (assignedNow && changed) {
        void orchestrators
          .get(existing.projectId)
          .onItemAssigned(item.id)
          .catch(() => undefined);
      }
    }
    return { workItem: item };
  });

  app.delete('/api/workitems/:workItemId', async (req, reply) => {
    const { workItemId } = req.params as { workItemId: string };
    const existing = store.getWorkItem(workItemId);
    if (!existing) throw new HttpError(404, 'Work item not found');
    // Epics own child tasks, an isolated clone, a PR and threads - cascade through
    // the orchestrator so nothing is orphaned. Tasks are a simple row delete.
    if (existing.kind === 'epic') {
      const revert = (req.query as { revert?: string }).revert === '1';
      const result = await orchestrators
        .get(existing.projectId)
        .discardEpic(workItemId, { revert });
      return { discarded: result };
    }
    store.deleteWorkItem(workItemId);
    bus.publish({ type: 'workitem.deleted', projectId: existing.projectId, workItemId });
    reply.status(204);
  });

  /* ----------------------------------------------------------------- chat */
  app.get('/api/projects/:id/chat', async (req) => {
    const { id } = req.params as { id: string };
    requireProject(id);
    return { messages: store.listChat(id) };
  });

  app.post('/api/projects/:id/chat', async (req, reply) => {
    const { id } = req.params as { id: string };
    requireProject(id);
    const input = sendChatSchema.parse(req.body);
    // Fire-and-forget: streaming happens over the WebSocket.
    void orchestrators
      .get(id)
      .chat(input.content, input.threadId)
      .catch(() => undefined);
    reply.status(202);
    return { accepted: true };
  });

  // File uploads for the chat composer. Accepts base64 JSON (no multipart dep) and
  // stores the file under <repoDir>/.ateam/uploads/ - inside the workspace so the
  // Team Lead's read tools can open it, but under the .ateam bookkeeping prefix
  // that is excluded from deliverables/commits. Returns a repo-relative path the
  // client references in the message it sends.
  app.post('/api/projects/:id/uploads', { bodyLimit: 32 * 1024 * 1024 }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = requireProject(id);
    const input = uploadFileSchema.parse(req.body);
    const safe = input.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'file';
    const rel = path.join('.ateam', 'uploads', `${Date.now()}-${safe}`);
    const abs = path.join(project.repoDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const buf = Buffer.from(input.dataBase64, 'base64');
    fs.writeFileSync(abs, buf);
    reply.status(201);
    return { path: rel.replace(/\\/g, '/'), name: input.name, bytes: buf.length };
  });

  app.post('/api/projects/:id/threads', async (req, reply) => {
    const { id } = req.params as { id: string };
    requireProject(id);
    const input = createThreadSchema.parse(req.body ?? {});
    const thread = orchestrators.get(id).createLeadThread(input.topic, input.workItemId);
    reply.status(201);
    return { thread };
  });

  /* ------------------------------------------------------------ questions */
  app.get('/api/projects/:id/questions', async (req) => {
    const { id } = req.params as { id: string };
    requireProject(id);
    return { questions: store.listQuestions(id) };
  });

  app.post('/api/questions/:questionId/answer', async (req) => {
    const { questionId } = req.params as { questionId: string };
    const input = answerQuestionSchema.parse(req.body);
    const all = store.listProjects();
    let projectId: string | undefined;
    for (const p of all) {
      if (store.listQuestions(p.id).some((q) => q.id === questionId)) {
        projectId = p.id;
        break;
      }
    }
    if (!projectId) throw new HttpError(404, 'Question not found');
    const ok = orchestrators.answer(projectId, questionId, input.answer);
    if (!ok) {
      // No in-memory waiter (e.g. after a restart); persist the answer anyway.
      const answered = store.answerQuestion(questionId, input.answer);
      if (answered) bus.publish({ type: 'question.updated', projectId, question: answered });
    }
    return { ok: true };
  });

  /* ------------------------------------------------------- notifications */
  app.get('/api/projects/:id/notifications', async (req) => {
    const { id } = req.params as { id: string };
    requireProject(id);
    return { notifications: store.listNotifications(id) };
  });

  app.post('/api/projects/:id/notifications/read-all', async (req) => {
    const { id } = req.params as { id: string };
    requireProject(id);
    store.markAllNotificationsRead(id);
    return { ok: true };
  });

  app.post('/api/notifications/:notificationId/read', async (req) => {
    const { notificationId } = req.params as { notificationId: string };
    const updated = store.markNotificationRead(notificationId);
    if (!updated) throw new HttpError(404, 'Notification not found');
    return { notification: updated };
  });

  /* ---------------------------------------------------------------- events */
  app.get('/api/projects/:id/events', async (req) => {
    const { id } = req.params as { id: string };
    requireProject(id);
    const query = z.object({ agentId: z.string().optional() }).parse(req.query);
    return { events: store.listEvents(id, query.agentId ? { agentId: query.agentId } : {}) };
  });

  return app;
}
