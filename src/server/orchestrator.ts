import path from 'node:path';
import type { Agent, Project, Thread, WorkItem } from '@shared/index';
import type { Store } from './db/store.js';
import type { Bus } from './bus.js';
import type {
  AgentSession,
  CopilotAdapter,
  PermissionAsk,
  SessionEvent,
  UserInputAsk,
} from './agents/adapter.js';
import { buildSystemPrompt } from './agents/context.js';
import { discoverSkills, skillDirectories } from './agents/skillScanner.js';
import type { SchedulerService } from './scheduler.js';

interface Deps {
  store: Store;
  bus: Bus;
  adapter: CopilotAdapter;
  skillHomeRoots: string[];
  scheduler: SchedulerService;
}

function isInsideWorkspace(repoDir: string, filePath: string | undefined): boolean {
  if (!filePath) return true;
  const root = path.resolve(repoDir);
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath);
  const rel = path.relative(root, abs);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

const GROUPCHAT_RE = /\[\[REQUEST_GROUPCHAT:\s*([^\]]+)\]\]/i;

/**
 * One independent, concurrent actor per agent: owns the agent's own Copilot
 * session (grounded with environment/project/team context) and a serialized
 * mailbox so a single agent isn't asked twice at once. Different actors run in
 * parallel — the team is truly async.
 */
class AgentActor {
  private session: AgentSession | null = null;
  private mailbox: Promise<unknown> = Promise.resolve();
  private currentWorkItemId: string | null = null;

  constructor(
    readonly agent: Agent,
    private readonly orch: ProjectOrchestrator,
  ) {}

  /** Ask this agent something in a thread; returns its final message text. */
  ask(prompt: string, threadId: string, workItemId: string | null): Promise<string> {
    const run = this.mailbox.then(
      () => this.runTurn(prompt, threadId, workItemId),
      () => this.runTurn(prompt, threadId, workItemId),
    );
    this.mailbox = run.catch(() => undefined);
    return run;
  }

  private async runTurn(
    prompt: string,
    threadId: string,
    workItemId: string | null,
  ): Promise<string> {
    this.currentWorkItemId = workItemId;
    const session = await this.ensureSession();
    const placeholder = this.orch.postMessage(threadId, this.agent, '');
    this.orch.setStatus(this.agent.id, 'working');
    try {
      const text = await session.ask(prompt, placeholder.id);
      const reply = text || '(no response)';
      this.orch.finalizeMessage(placeholder.id, reply);
      await this.orch.maybeHandleGroupChatRequest(this.agent, reply, workItemId);
      return reply;
    } finally {
      this.orch.setStatus(this.agent.id, 'idle');
    }
  }

  private async ensureSession(): Promise<AgentSession> {
    if (this.session) return this.session;
    const { project, team } = this.orch.snapshot();
    const skills = discoverSkills(
      this.orch.deps.skillHomeRoots,
      project.repoDir,
      project.settings.extraSkillRoots,
    );
    const persona = buildSystemPrompt({ project, self: this.agent, team });
    this.session = await this.orch.deps.adapter.createAgentSession({
      projectId: project.id,
      agentId: this.agent.id,
      agentName: this.agent.name,
      displayName: this.agent.displayName,
      role: this.agent.kind,
      persona,
      model: this.agent.model || project.settings.defaultModel,
      tools: this.agent.tools,
      skills: this.agent.skills,
      workingDirectory: project.repoDir,
      skillDirectories: skillDirectories(skills),
      approvalMode: project.settings.approvalMode,
      scheduler: this.orch.deps.scheduler,
      onEvent: (e) => this.orch.onSessionEvent(this.agent, e, this.currentWorkItemId),
      onPermission: (ask) => this.orch.handlePermission(ask),
      onUserInput: (ask) => this.orch.handleUserInput(this.agent, ask),
    });
    return this.session;
  }

  async dispose(): Promise<void> {
    if (this.session) await this.session.dispose().catch(() => undefined);
    this.session = null;
  }
}

/** Coordinates a project's team of actors, threads, board work, and escalations. */
class ProjectOrchestrator {
  private actors = new Map<string, AgentActor>();
  private mainThreadId: string | null = null;
  private readonly pending = new Map<string, (answer: string) => void>();
  private groupDepth = 0;

  constructor(
    private readonly projectId: string,
    readonly deps: Deps,
  ) {}

  /* ----------------------------------------------------------- snapshots */

  private project(): Project {
    const p = this.deps.store.getProject(this.projectId);
    if (!p) throw new Error(`project ${this.projectId} not found`);
    return p;
  }

  snapshot(): { project: Project; team: Agent[] } {
    return { project: this.project(), team: this.deps.store.listAgents(this.projectId) };
  }

  private actor(agent: Agent): AgentActor {
    let a = this.actors.get(agent.id);
    if (!a) {
      a = new AgentActor(agent, this);
      this.actors.set(agent.id, a);
    }
    return a;
  }

  private lead(): Agent {
    const lead = this.deps.store.getLead(this.projectId);
    if (!lead) throw new Error('project has no Team Lead');
    return lead;
  }

  private specialists(): Agent[] {
    return this.deps.store.listAgents(this.projectId).filter((a) => a.kind === 'specialist');
  }

  private ensureMainThread(): Thread {
    const t = this.deps.store.ensureMainThread(this.projectId);
    if (!this.mainThreadId) {
      this.mainThreadId = t.id;
      this.deps.bus.publish({ type: 'thread.updated', projectId: this.projectId, thread: t });
    }
    return t;
  }

  /* -------------------------------------------------------------- events */

  onSessionEvent(agent: Agent, e: SessionEvent, workItemId: string | null): void {
    const { bus } = this.deps;
    const pid = this.projectId;
    switch (e.kind) {
      case 'delta':
        bus.publish({ type: 'chat.delta', projectId: pid, messageId: e.messageId, delta: e.delta });
        break;
      case 'message':
        this.finalizeMessage(e.messageId, e.text);
        break;
      case 'reasoning':
        this.emitEvent(agent.id, 'reasoning', e.text, { text: e.text }, workItemId);
        break;
      case 'tool_call':
        this.emitEvent(agent.id, 'tool_call', e.toolName, e.detail ?? null, workItemId);
        break;
      case 'tool_result':
        if (e.toolName === 'update_task_board' && e.detail) {
          const task = this.deps.store.upsertTask({
            projectId: pid,
            agentId: agent.id,
            workItemId,
            title: String(e.detail.title ?? 'task'),
            status: (e.detail.status as 'todo' | 'doing' | 'done') ?? 'doing',
          });
          bus.publish({ type: 'task.updated', projectId: pid, task });
        } else {
          this.emitEvent(
            agent.id,
            'tool_result',
            `${e.toolName} done`,
            e.detail ?? null,
            workItemId,
          );
        }
        break;
      case 'idle':
        break;
    }
  }

  /* -------------------------------------------------------- thread posts */

  /** Create a placeholder message authored by an agent and broadcast it. */
  postMessage(threadId: string, author: Agent, content: string): { id: string } {
    const msg = this.deps.store.appendChat({
      projectId: this.projectId,
      threadId,
      role: 'agent',
      authorAgentId: author.id,
      content,
    });
    this.deps.bus.publish({ type: 'chat.message', projectId: this.projectId, message: msg });
    return msg;
  }

  finalizeMessage(messageId: string, text: string): void {
    const updated = this.deps.store.updateChat(messageId, text);
    if (updated) {
      this.deps.bus.publish({ type: 'chat.message', projectId: this.projectId, message: updated });
      const author = updated.authorAgentId
        ? this.deps.store.getAgent(updated.authorAgentId)
        : undefined;
      this.emitEvent(
        updated.authorAgentId,
        'message',
        `${author?.displayName ?? 'Agent'}: ${text.slice(0, 200)}`,
        null,
        null,
      );
    }
  }

  /* --------------------------------------------------------- user chat */

  chat(content: string): Promise<void> {
    const main = this.ensureMainThread();
    const userMsg = this.deps.store.appendChat({
      projectId: this.projectId,
      threadId: main.id,
      role: 'user',
      authorAgentId: null,
      content,
    });
    this.deps.bus.publish({ type: 'chat.message', projectId: this.projectId, message: userMsg });

    return (async () => {
      const lead = this.lead();
      const roster = this.specialists()
        .map((s) => `- \`${s.name}\` (${s.displayName}): ${s.description}`)
        .join('\n');
      const history = this.recentHistory(main.id);
      const prompt =
        `The user says:\n"""\n${content}\n"""\n\n` +
        `Team available:\n${roster || '(no specialists yet)'}\n\n` +
        `Conversation so far:\n${history}\n\n` +
        `Respond to the user. If this needs hands-on work, say briefly how you'll approach it as an epic. ` +
        `If it would benefit from a team discussion, note that you'll convene one.`;
      await this.actor(lead).ask(prompt, main.id, null);

      // Convene a brainstorm when the user asks to build/plan/discuss.
      if (/\b(build|implement|design|plan|brainstorm|discuss|architect|feature)\b/i.test(content)) {
        const participants = this.pickDiscussants();
        if (participants.length > 0) {
          await this.runGroupChat(
            `How should we approach: ${content.slice(0, 80)}`,
            participants,
            null,
          );
        }
      }
    })();
  }

  /* ------------------------------------------------------- group chats */

  /** Lead-moderated group discussion: each participant contributes in parallel. */
  async runGroupChat(
    topic: string,
    participantIds: string[],
    workItemId: string | null,
  ): Promise<string> {
    if (this.groupDepth >= 2) return ''; // guard against runaway nesting
    this.groupDepth += 1;
    try {
      const lead = this.lead();
      const participants = participantIds
        .map((id) => this.deps.store.getAgent(id))
        .filter((a): a is Agent => !!a && a.kind === 'specialist');
      const thread = this.deps.store.createThread({
        projectId: this.projectId,
        kind: 'group',
        topic,
        workItemId,
        participantAgentIds: [lead.id, ...participants.map((p) => p.id)],
        includesUser: true,
      });
      this.deps.bus.publish({ type: 'thread.updated', projectId: this.projectId, thread });

      // Lead opens the discussion.
      await this.actor(lead).ask(
        `You are moderating a group discussion titled "${topic}". Open it by framing the goal and the key questions for the team in 2-3 sentences.`,
        thread.id,
        workItemId,
      );

      // Participants contribute concurrently (truly async).
      const contributions = await Promise.all(
        participants.map((p) =>
          this.actor(p).ask(
            `Group discussion "${topic}". Give your concrete recommendation from your discipline in 2-4 sentences. Reference specifics.`,
            thread.id,
            workItemId,
          ),
        ),
      );

      // Lead synthesizes.
      const summary = await this.actor(lead).ask(
        `Synthesize the discussion "${topic}" into a clear decision and next steps.\n\nContributions:\n${contributions
          .map((c, i) => `- ${participants[i]!.displayName}: ${c}`)
          .join('\n')}`,
        thread.id,
        workItemId,
      );

      // Post a short summary back to the main thread so the user stays informed.
      const main = this.ensureMainThread();
      this.postMessage(main.id, lead, `📋 Discussion "${topic}" concluded. ${summary}`);
      this.deps.store.appendEvent({
        projectId: this.projectId,
        agentId: lead.id,
        type: 'discussion',
        summary: `Group chat: ${topic}`,
      });
      this.deps.bus.publish({
        type: 'thread.updated',
        projectId: this.projectId,
        thread: this.deps.store.closeThread(thread.id) ?? thread,
      });
      return summary;
    } finally {
      this.groupDepth -= 1;
    }
  }

  /** When an agent asks the Lead to open a group chat, convene the right people. */
  async maybeHandleGroupChatRequest(
    requester: Agent,
    reply: string,
    workItemId: string | null,
  ): Promise<void> {
    const m = reply.match(GROUPCHAT_RE);
    if (!m) return;
    const topic = m[1]!.trim();
    const others = this.specialists().filter((s) => s.id !== requester.id);
    const participants = [requester.id, ...others.slice(0, 3).map((s) => s.id)];
    this.deps.store.appendEvent({
      projectId: this.projectId,
      agentId: requester.id,
      type: 'discussion',
      summary: `${requester.displayName} requested a group chat: ${topic}`,
    });
    await this.runGroupChat(topic, participants, workItemId);
  }

  private pickDiscussants(): string[] {
    // Prefer PM + UX + core engineers when present; else first few specialists.
    const specialists = this.specialists();
    const preferred = ['pm', 'ux', 'frontend', 'backend', 'qa'];
    const chosen = specialists.filter((s) => preferred.includes(s.name)).map((s) => s.id);
    const rest = specialists.filter((s) => !preferred.includes(s.name)).map((s) => s.id);
    return [...chosen, ...rest].slice(0, 4);
  }

  private recentHistory(threadId: string, limit = 8): string {
    const msgs = this.deps.store.listThreadMessages(threadId).slice(-limit);
    return (
      msgs
        .map((m) => {
          const who = m.authorAgentId
            ? (this.deps.store.getAgent(m.authorAgentId)?.displayName ?? 'Agent')
            : 'User';
          return `${who}: ${m.content}`;
        })
        .join('\n') || '(no messages yet)'
    );
  }

  /* ---------------------------------------------------------- board work */

  onItemAssigned(workItemId: string): Promise<void> {
    return this.runWorkItem(workItemId);
  }

  private async runWorkItem(workItemId: string): Promise<void> {
    const item = this.deps.store.getWorkItem(workItemId);
    if (!item || !item.assigneeAgentId) return;
    const agent = this.deps.store.getAgent(item.assigneeAgentId);
    if (!agent || agent.kind !== 'specialist') return;
    if (item.status === 'done' || item.status === 'in_progress') return;

    this.moveItem(item.id, 'in_progress');
    const main = this.ensureMainThread();
    const startTask = this.deps.store.upsertTask({
      projectId: this.projectId,
      agentId: agent.id,
      workItemId: item.id,
      title: item.title,
      status: 'doing',
    });
    this.deps.bus.publish({ type: 'task.updated', projectId: this.projectId, task: startTask });
    const prompt =
      `The Team Lead assigned you this task. Work on it and report progress to the team.\n\n` +
      `Task: ${item.title}\nDetails: ${item.description || '(none)'}\n` +
      `When done, summarize what you did.`;
    await this.actor(agent).ask(prompt, main.id, item.id);

    const doneTask = this.deps.store.upsertTask({
      projectId: this.projectId,
      agentId: agent.id,
      workItemId: item.id,
      title: item.title,
      status: 'done',
    });
    this.deps.bus.publish({ type: 'task.updated', projectId: this.projectId, task: doneTask });
    const latest = this.deps.store.getWorkItem(item.id);
    if (latest && latest.status === 'in_progress') this.moveItem(item.id, 'review');
    await this.pullNext(agent.id);
  }

  private async pullNext(agentId: string): Promise<void> {
    const next = this.deps.store.nextAssignedItem(this.projectId, agentId);
    if (next) await this.runWorkItem(next.id);
  }

  /* -------------------------------------------------------- primitives */

  private moveItem(workItemId: string, status: WorkItem['status']): void {
    const updated = this.deps.store.updateWorkItem(workItemId, { status });
    if (updated)
      this.deps.bus.publish({
        type: 'workitem.updated',
        projectId: this.projectId,
        workItem: updated,
      });
  }

  setStatus(agentId: string, status: Agent['status']): void {
    const updated = this.deps.store.setAgentStatus(agentId, status);
    if (updated) {
      this.deps.bus.publish({ type: 'agent.status', projectId: this.projectId, agentId, status });
      this.deps.store.appendEvent({
        projectId: this.projectId,
        agentId,
        type: 'status_change',
        summary: `Status → ${status}`,
      });
    }
  }

  private emitEvent(
    agentId: string | null,
    type: Parameters<Store['appendEvent']>[0]['type'],
    summary: string,
    detail: Record<string, unknown> | null,
    workItemId: string | null,
  ): void {
    const event = this.deps.store.appendEvent({
      projectId: this.projectId,
      agentId,
      workItemId,
      type,
      summary,
      detail,
    });
    this.deps.bus.publish({ type: 'event.appended', projectId: this.projectId, event });
  }

  /* -------------------------------------------------- perms & escalation */

  async handlePermission(ask: PermissionAsk): Promise<'approve' | 'reject'> {
    const project = this.project();
    if (project.settings.approvalMode === 'auto-workspace') {
      if (ask.kind === 'read') return 'approve';
      return isInsideWorkspace(project.repoDir, ask.fileName) ? 'approve' : 'reject';
    }
    const label =
      ask.kind === 'shell'
        ? `run: ${ask.command ?? ''}`
        : ask.fileName
          ? `${ask.kind} ${ask.fileName}`
          : `use ${ask.toolName ?? ask.kind}`;
    const answer = await this.raiseQuestion(null, `Approve ${label}?`, ['Approve', 'Reject']);
    return answer.toLowerCase().startsWith('a') ? 'approve' : 'reject';
  }

  async handleUserInput(agent: Agent, ask: UserInputAsk): Promise<string> {
    this.setStatus(agent.id, 'needs_input');
    const answer = await this.raiseQuestion(agent.id, ask.question, ask.choices);
    this.setStatus(agent.id, 'working');
    return answer;
  }

  private raiseQuestion(
    agentId: string | null,
    question: string,
    choices?: string[],
  ): Promise<string> {
    const q = this.deps.store.createQuestion({
      projectId: this.projectId,
      agentId,
      question,
      choices: choices ?? null,
    });
    this.deps.bus.publish({ type: 'question.updated', projectId: this.projectId, question: q });
    this.deps.store.appendEvent({
      projectId: this.projectId,
      agentId,
      type: 'escalation',
      summary: `Asked: ${question}`,
    });
    return new Promise<string>((resolve) => {
      this.pending.set(q.id, (answer) => {
        const answered = this.deps.store.answerQuestion(q.id, answer);
        if (answered)
          this.deps.bus.publish({
            type: 'question.updated',
            projectId: this.projectId,
            question: answered,
          });
        resolve(answer);
      });
    });
  }

  answer(questionId: string, answer: string): boolean {
    const resolve = this.pending.get(questionId);
    if (!resolve) return false;
    this.pending.delete(questionId);
    resolve(answer);
    return true;
  }

  async invalidateSession(): Promise<void> {
    for (const a of this.actors.values()) await a.dispose();
    this.actors.clear();
  }

  async dispose(): Promise<void> {
    await this.invalidateSession();
  }
}

/** Owns one orchestrator per project; enables many projects to run in parallel. */
export class OrchestratorManager {
  private readonly byProject = new Map<string, ProjectOrchestrator>();

  constructor(private readonly deps: Deps) {}

  get(projectId: string): ProjectOrchestrator {
    let o = this.byProject.get(projectId);
    if (!o) {
      o = new ProjectOrchestrator(projectId, this.deps);
      this.byProject.set(projectId, o);
    }
    return o;
  }

  async invalidate(projectId: string): Promise<void> {
    await this.byProject.get(projectId)?.invalidateSession();
  }

  async remove(projectId: string): Promise<void> {
    const o = this.byProject.get(projectId);
    if (o) {
      await o.dispose();
      this.byProject.delete(projectId);
    }
    this.deps.scheduler.cancelOwner(projectId);
  }

  answer(projectId: string, questionId: string, answer: string): boolean {
    return this.byProject.get(projectId)?.answer(questionId, answer) ?? false;
  }

  async shutdown(): Promise<void> {
    for (const o of this.byProject.values()) await o.dispose();
    this.byProject.clear();
    this.deps.scheduler.dispose();
    await this.deps.adapter.shutdown();
  }
}

export type { ProjectOrchestrator };
