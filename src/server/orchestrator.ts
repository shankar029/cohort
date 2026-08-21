import path from 'node:path';
import type { Agent, Project, Thread, WorkItem } from '@shared/index';
import type { Store } from './db/store.js';
import type { Bus } from './bus.js';
import type {
  AgentAppTools,
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
      appTools: this.orch.appToolsFor(this.agent),
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

      // Route the request. A build/change request becomes an epic the Lead decomposes;
      // a pure discussion request convenes a brainstorm.
      const buildIntent =
        /\b(build|implement|create|add|develop|feature|fix|refactor|integrate|migrate|support)\b/i.test(
          content,
        );
      const discussIntent = /\b(brainstorm|discuss|approach|architect|explore|options)\b/i.test(
        content,
      );
      if (buildIntent) {
        await this.planEpic(content);
      } else if (discussIntent) {
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

  /* --------------------------------------------------------- epic planning */

  /**
   * Turn a user request into an epic the Team Lead owns: consult the PM, frame a
   * plan, then decompose into stream-tagged task cards (with acceptance criteria +
   * dependencies) assigned to specialists for parallel work.
   */
  async planEpic(content: string): Promise<WorkItem> {
    const lead = this.lead();
    const main = this.ensureMainThread();
    const specs = this.specialists();

    // 1. Open the epic.
    const epic = this.deps.store.createWorkItem({
      projectId: this.projectId,
      kind: 'epic',
      title: epicTitle(content),
      description: content,
      status: 'in_progress',
      priority: 'medium',
      assigneeAgentId: lead.id,
    });
    this.deps.bus.publish({ type: 'workitem.updated', projectId: this.projectId, workItem: epic });
    this.emitEvent(lead.id, 'system', `Opened epic “${epic.title}”`, null, epic.id);

    // 2. Consult the Product Manager for outcome + acceptance criteria (if present).
    const pm = specs.find((s) => s.name === 'pm');
    if (pm) {
      await this.actor(pm).ask(
        `Product check for epic “${epic.title}”.\nRequest: ${content}\n` +
          `State the user outcome and 2-3 crisp acceptance criteria in a few sentences.`,
        main.id,
        epic.id,
      );
    }

    // 3. Lead frames the plan for the team.
    await this.actor(lead).ask(
      `You own epic “${epic.title}”. Break it into parallel tasks by stream for the team, ` +
        `note dependencies and the quality bar, and keep it concise.`,
      main.id,
      epic.id,
    );

    // 4. Decompose into stream-tagged task cards. Builders run in parallel now;
    //    verifiers (QA/review/security) wait on the build tasks (dependency-gated in Phase 3).
    const verifiers = specs.filter((s) => /^(qa|reviewer|security)$/.test(s.name));
    const builders = specs.filter((s) => s.name !== 'pm' && !verifiers.includes(s));
    const goal = shortGoal(content);
    const builderTaskIds: string[] = [];
    for (const s of builders) {
      const task = this.deps.store.createWorkItem({
        projectId: this.projectId,
        kind: 'task',
        parentId: epic.id,
        title: `[${s.name}] ${goal}`,
        description:
          `Part of epic “${epic.title}”.\n\nAcceptance criteria: deliver the ${s.displayName} ` +
          `slice of “${goal}” to a principal-engineer standard — correct, tested, and matching ` +
          `project conventions.`,
        status: 'todo',
        priority: 'medium',
        assigneeAgentId: s.id,
        stream: s.name,
      });
      this.deps.bus.publish({
        type: 'workitem.updated',
        projectId: this.projectId,
        workItem: task,
      });
      this.emitEvent(lead.id, 'system', `Assigned [${s.name}] ${goal}`, null, task.id);
      builderTaskIds.push(task.id);
      void this.onItemAssigned(task.id).catch(() => undefined);
    }
    for (const v of verifiers) {
      const task = this.deps.store.createWorkItem({
        projectId: this.projectId,
        kind: 'task',
        parentId: epic.id,
        title: `[${v.name}] verify ${goal}`,
        description:
          `Part of epic “${epic.title}”.\n\nAcceptance criteria: ${v.displayName} sign-off — ` +
          `verify the build tasks meet the quality bar before the epic is done.`,
        status: 'backlog',
        priority: 'medium',
        assigneeAgentId: v.id,
        stream: v.name,
        dependsOn: builderTaskIds,
      });
      this.deps.bus.publish({
        type: 'workitem.updated',
        projectId: this.projectId,
        workItem: task,
      });
      this.emitEvent(
        lead.id,
        'system',
        `Queued [${v.name}] verification (waits on builds)`,
        null,
        task.id,
      );
    }
    return epic;
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

  /* ------------------------------------------------------ scheduled work */

  private readonly armed = new Set<string>();

  /** Arm any scheduled items already persisted for this project (called on boot). */
  armSchedules(): void {
    for (const item of this.deps.store.listScheduledWorkItems(this.projectId)) {
      this.scheduleWorkItem(item);
    }
  }

  /** Register a scheduled/recurring item to activate at its time. */
  scheduleWorkItem(item: WorkItem): void {
    if (item.scheduledAt == null || this.armed.has(item.id)) return;
    this.armed.add(item.id);
    const delay = item.scheduledAt - Date.now();
    if (delay <= 0) {
      this.activateScheduled(item.id);
      return;
    }
    this.deps.scheduler.after(delay, () => this.activateScheduled(item.id), this.projectId);
  }

  private activateScheduled(itemId: string): void {
    const item = this.deps.store.getWorkItem(itemId);
    if (!item) return;
    this.armed.delete(itemId);

    if (item.status === 'backlog') {
      const activated = this.deps.store.updateWorkItem(itemId, { status: 'todo' });
      if (activated) {
        this.deps.bus.publish({
          type: 'workitem.updated',
          projectId: this.projectId,
          workItem: activated,
        });
        if (activated.assigneeAgentId) {
          void this.onItemAssigned(itemId).catch(() => undefined);
        }
      }
    }

    // Recurring: schedule the next occurrence (rolled forward to a future time).
    const stepMs = recurrenceMs(item.recurrence);
    if (stepMs && item.scheduledAt != null) {
      let nextAt = item.scheduledAt + stepMs;
      while (nextAt <= Date.now()) nextAt += stepMs;
      const next = this.deps.store.createWorkItem({
        projectId: this.projectId,
        title: item.title,
        description: item.description,
        status: 'backlog',
        priority: item.priority,
        assigneeAgentId: item.assigneeAgentId,
        scheduledAt: nextAt,
        recurrence: item.recurrence,
      });
      this.deps.bus.publish({
        type: 'workitem.updated',
        projectId: this.projectId,
        workItem: next,
      });
      this.scheduleWorkItem(next);
    }
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

  /** Board/chat capabilities exposed to an agent as first-class tools. */
  appToolsFor(agent: Agent): AgentAppTools {
    const pid = this.projectId;
    return {
      createWorkItem: (input) => {
        const assignee = input.assigneeName ? this.findAgentByName(input.assigneeName) : null;
        const item = this.deps.store.createWorkItem({
          projectId: pid,
          title: input.title,
          description: input.acceptanceCriteria
            ? `${input.description ?? ''}\n\nAcceptance criteria:\n${input.acceptanceCriteria}`.trim()
            : (input.description ?? ''),
          status: (input.status as WorkItem['status']) ?? 'todo',
          priority: 'medium',
          assigneeAgentId: assignee?.id ?? null,
          kind: 'task',
          parentId: input.parentId ?? null,
          stream: input.stream ?? null,
        });
        this.deps.bus.publish({ type: 'workitem.updated', projectId: pid, workItem: item });
        this.emitEvent(agent.id, 'system', `Created task “${item.title}”`, null, item.id);
        if (item.assigneeAgentId && (item.status === 'todo' || item.status === 'backlog')) {
          void this.onItemAssigned(item.id).catch(() => undefined);
        }
        return { id: item.id, title: item.title };
      },
      moveWorkItem: (input) => {
        const before = this.deps.store.getWorkItem(input.workItemId);
        if (!before) return { ok: false };
        this.moveItem(input.workItemId, input.status as WorkItem['status']);
        this.emitEvent(
          agent.id,
          'system',
          `Moved “${before.title}” → ${input.status}`,
          null,
          input.workItemId,
        );
        return { ok: true };
      },
      postMessage: (input) => {
        const threadId = input.threadId ?? this.ensureMainThread().id;
        const msg = this.postMessage(threadId, agent, input.content);
        this.finalizeMessage(msg.id, input.content);
        return { ok: true };
      },
      requestGroupChat: (input) => {
        void this.maybeHandleGroupChatRequest(
          agent,
          `[[REQUEST_GROUPCHAT: ${input.topic}]]`,
          null,
        ).catch(() => undefined);
        return { ok: true };
      },
      listBoard: () => ({
        items: this.deps.store.listWorkItems(pid).map((i) => ({
          id: i.id,
          title: i.title,
          status: i.status,
          stream: i.stream,
          assignee: i.assigneeAgentId
            ? (this.deps.store.getAgent(i.assigneeAgentId)?.displayName ?? null)
            : null,
        })),
      }),
    };
  }

  private findAgentByName(name: string): Agent | null {
    const needle = name.trim().toLowerCase();
    const team = this.deps.store.listAgents(this.projectId);
    return (
      team.find((a) => a.name.toLowerCase() === needle) ??
      team.find((a) => a.displayName.toLowerCase() === needle) ??
      team.find((a) => a.displayName.toLowerCase().includes(needle)) ??
      null
    );
  }

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

/** A concise, board-friendly goal phrase from a free-form user request. */
function shortGoal(content: string): string {
  const first = content.split('\n').find((l) => l.trim().length > 0) ?? content;
  const cleaned = first
    .replace(/^\s*(please|can you|could you|hey|hi)[,\s]+/i, '')
    .replace(/[.?!]+\s*$/, '')
    .trim();
  return (cleaned.length > 70 ? `${cleaned.slice(0, 67)}…` : cleaned) || 'the requested work';
}

/** Epic title from a request — capitalized short goal. */
function epicTitle(content: string): string {
  const g = shortGoal(content);
  return g.charAt(0).toUpperCase() + g.slice(1);
}

/** Milliseconds between recurrences, or null for a one-shot schedule. */
function recurrenceMs(r: WorkItem['recurrence']): number | null {
  switch (r) {
    case 'hourly':
      return 3_600_000;
    case 'daily':
      return 86_400_000;
    case 'weekly':
      return 604_800_000;
    default:
      return null;
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
      o.armSchedules();
    }
    return o;
  }

  /** Re-arm scheduled work across all known projects (call once at startup). */
  resumeAll(projectIds: string[]): void {
    for (const pid of projectIds) this.get(pid);
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
