import Fastify, { type FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import type { Store } from './db/store.js';
import type { Bus } from './bus.js';
import type { OrchestratorManager } from './orchestrator.js';
import {
  answerQuestionSchema,
  createAgentSchema,
  createProjectSchema,
  createWorkItemSchema,
  sendChatSchema,
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

export function buildApp(ctx: AppContext): FastifyInstance {
  const app = Fastify({ logger: false });
  const { store, bus, orchestrators, config } = ctx;

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
      },
    });
    if (updated) {
      bus.publish({ type: 'project.updated', project: updated });
      await orchestrators.invalidate(id);
    }
    return { project: updated };
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
    const item = store.createWorkItem({
      projectId: id,
      title: input.title,
      description: input.description ?? '',
      status: input.status ?? 'backlog',
      priority: input.priority ?? 'medium',
      assigneeAgentId: input.assigneeAgentId ?? null,
    });
    bus.publish({ type: 'workitem.updated', projectId: id, workItem: item });
    reply.status(201);
    if (item.assigneeAgentId)
      void orchestrators
        .get(id)
        .onItemAssigned(item.id)
        .catch(() => undefined);
    return { workItem: item };
  });

  app.patch('/api/workitems/:workItemId', async (req) => {
    const { workItemId } = req.params as { workItemId: string };
    const existing = store.getWorkItem(workItemId);
    if (!existing) throw new HttpError(404, 'Work item not found');
    const input = updateWorkItemSchema.parse(req.body);
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
      .chat(input.content)
      .catch(() => undefined);
    reply.status(202);
    return { accepted: true };
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

  /* ---------------------------------------------------------------- events */
  app.get('/api/projects/:id/events', async (req) => {
    const { id } = req.params as { id: string };
    requireProject(id);
    const query = z.object({ agentId: z.string().optional() }).parse(req.query);
    return { events: store.listEvents(id, query.agentId ? { agentId: query.agentId } : {}) };
  });

  return app;
}
