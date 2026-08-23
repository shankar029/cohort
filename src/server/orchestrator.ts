import path from 'node:path';
import fs from 'node:fs';
import type { Agent, NotificationType, Project, Thread, WorkItem } from '@shared/index';
import type { GitFileChange } from '@shared/index';
import type { GitCommit } from '@shared/index';
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
import type { Cancel, SchedulerService } from './scheduler.js';
import type { GitService } from './git.js';

interface Deps {
  store: Store;
  bus: Bus;
  adapter: CopilotAdapter;
  skillHomeRoots: string[];
  scheduler: SchedulerService;
  git: GitService;
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
  private sessions = new Map<string, AgentSession>();
  private mailbox: Promise<unknown> = Promise.resolve();
  private currentWorkItemId: string | null = null;

  constructor(
    readonly agent: Agent,
    private readonly orch: ProjectOrchestrator,
  ) {}

  /** Ask this agent something in a thread; returns its final message text. */
  ask(
    prompt: string,
    threadId: string,
    workItemId: string | null,
    workingDirectory?: string,
  ): Promise<string> {
    const run = this.mailbox.then(
      () => this.runTurn(prompt, threadId, workItemId, workingDirectory),
      () => this.runTurn(prompt, threadId, workItemId, workingDirectory),
    );
    this.mailbox = run.catch(() => undefined);
    return run;
  }

  private async runTurn(
    prompt: string,
    threadId: string,
    workItemId: string | null,
    workingDirectory?: string,
  ): Promise<string> {
    this.currentWorkItemId = workItemId;
    const { project } = this.orch.snapshot();
    const cwd = workingDirectory ?? project.repoDir;
    const session = await this.ensureSession(cwd);
    const placeholder = this.orch.postMessage(threadId, this.agent, '');
    this.orch.setStatus(this.agent.id, 'working');
    try {
      const text = await session.ask(prompt, placeholder.id);
      const reply = text.trim();
      if (reply) {
        this.orch.finalizeMessage(placeholder.id, reply);
        await this.orch.maybeHandleGroupChatRequest(this.agent, reply, workItemId);
      } else {
        // Tool-only turn (e.g. the agent acted via app tools): drop the empty
        // placeholder instead of leaving a dangling "…" / "(no response)" bubble.
        this.orch.deleteMessage(placeholder.id);
      }
      return reply;
    } finally {
      this.orch.setStatus(this.agent.id, 'idle');
    }
  }

  /** One session per working directory, so cross-epic worktrees stay isolated. */
  private async ensureSession(cwd: string): Promise<AgentSession> {
    const existing = this.sessions.get(cwd);
    if (existing) return existing;
    const { project, team } = this.orch.snapshot();
    const skills = discoverSkills(
      this.orch.deps.skillHomeRoots,
      project.repoDir,
      project.settings.extraSkillRoots,
    );
    const persona = buildSystemPrompt({
      project,
      self: this.agent,
      team,
      workingDirectory: cwd,
    });
    const session = await this.orch.deps.adapter.createAgentSession({
      projectId: project.id,
      agentId: this.agent.id,
      agentName: this.agent.name,
      displayName: this.agent.displayName,
      role: this.agent.kind,
      persona,
      model: this.agent.model || project.settings.defaultModel,
      tools: this.agent.tools,
      skills: this.agent.skills,
      workingDirectory: cwd,
      skillDirectories: skillDirectories(skills),
      approvalMode: project.settings.approvalMode,
      scheduler: this.orch.deps.scheduler,
      appTools: this.orch.appToolsFor(this.agent),
      onEvent: (e) => this.orch.onSessionEvent(this.agent, e, this.currentWorkItemId),
      onPermission: (ask) => this.orch.handlePermission(ask, this.agent),
      onUserInput: (ask) => this.orch.handleUserInput(this.agent, ask),
    });
    this.sessions.set(cwd, session);
    return session;
  }

  async dispose(): Promise<void> {
    for (const s of this.sessions.values()) await s.dispose().catch(() => undefined);
    this.sessions.clear();
  }
}

/** Coordinates a project's team of actors, threads, board work, and escalations. */
class ProjectOrchestrator {
  private actors = new Map<string, AgentActor>();
  private mainThreadId: string | null = null;
  private readonly pending = new Map<string, (answer: string) => void>();
  private groupDepth = 0;
  /** Per-epic isolated git worktree (branch + path), so epics don't collide. */
  private readonly epicWorktrees = new Map<string, { branch: string; path: string }>();
  /** PR/review state per epic for the iterate-to-quality loop. */
  private readonly epicPr = new Map<string, string>();
  private readonly epicReviewIter = new Map<string, number>();
  private readonly epicReviewing = new Set<string>();
  /** In-flight background reviews, awaited on dispose so nothing touches a closed DB. */
  private readonly pendingReviews = new Set<Promise<unknown>>();
  /** Per-message accumulated streamed text, so deltas survive a re-sync. */
  private readonly streamBuffers = new Map<string, string>();
  private static readonly MAX_REVIEW_ITER = 3;

  /** Work items with an in-flight runWorkItem, so the manager never double-starts one. */
  private readonly running = new Set<string>();
  /** Work items parked awaiting a human/Lead decision, so the manager won't re-drive them. */
  private readonly awaitingInput = new Set<string>();

  /** Team Lead proactive manager loop. */
  private readonly leadTickMs = Number(process.env.ATEAM_LEAD_TICK_MS ?? 15000);
  private leadStarted = false;
  private disposed = false;
  private leadPoke?: Cancel;
  /** agentId -> last time the Lead nudged them, so guidance stays low-noise. */
  private readonly leadNudges = new Map<string, number>();
  /** Throttle + dedupe the Lead's status heartbeat posted to main chat. */
  private readonly statusHeartbeatMs = Number(process.env.ATEAM_STATUS_HEARTBEAT_MS ?? 90000);
  private lastStatusAt = 0;
  private lastStatusSig = '';
  /** reviewerAgentId -> the PR they are actively reviewing (for add_review_comment). */
  private readonly reviewContext = new Map<string, { epicId: string; prId: string }>();

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
        // Persist the growing text so a reconnect/re-fetch doesn't lose streamed
        // content (the store otherwise only holds the empty placeholder until final).
        this.appendDelta(e.messageId, e.delta);
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
    this.streamBuffers.delete(messageId);
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

  /** Accumulate streamed deltas into the persisted message so re-syncs keep the text. */
  private appendDelta(messageId: string, delta: string): void {
    const next = (this.streamBuffers.get(messageId) ?? '') + delta;
    this.streamBuffers.set(messageId, next);
    this.deps.store.updateChat(messageId, next);
  }

  /** Remove a message entirely (e.g. an empty placeholder from a tool-only turn). */
  deleteMessage(messageId: string): void {
    this.streamBuffers.delete(messageId);
    this.deps.store.deleteChat(messageId);
    this.deps.bus.publish({ type: 'chat.deleted', projectId: this.projectId, messageId });
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
    this.notify(
      'epic',
      `New epic: ${epic.title}`,
      'The Team Lead opened an epic and is planning the work.',
      'board',
      epic.id,
      lead.id,
    );

    // Isolate the epic in its own git branch + worktree so parallel epics never
    // share a filesystem. Best-effort: fall back to the repo dir if git is unavailable.
    try {
      const wt = await this.deps.git.createEpicWorktree(
        this.project().repoDir,
        this.projectId,
        epic.id,
      );
      this.epicWorktrees.set(epic.id, wt);
      const withBranch = this.deps.store.updateWorkItem(epic.id, { branch: wt.branch });
      if (withBranch)
        this.deps.bus.publish({
          type: 'workitem.updated',
          projectId: this.projectId,
          workItem: withBranch,
        });
      this.emitEvent(
        lead.id,
        'git',
        `Created branch ${wt.branch} + isolated worktree`,
        null,
        epic.id,
      );
    } catch (err) {
      this.emitEvent(
        lead.id,
        'git',
        `Worktree setup skipped: ${err instanceof Error ? err.message : String(err)}`,
        null,
        epic.id,
      );
    }

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

    // 2b. The Architect designs the epic before the team builds it: approach,
    //     components, risks, and a stream-tagged breakdown. Recorded as the
    //     epic's living plan and posted to the team.
    const architect = specs.find((s) => s.name === 'architect');
    if (architect) {
      await this.actor(architect).ask(
        `Design epic “${epic.title}” before the team builds it.\nRequest: ${content}\n` +
          `Produce a concise technical design: approach and key decisions, the components/` +
          `interfaces, risks and mitigations, and a dependency-ordered breakdown into small ` +
          `stream-tagged tasks. Record it with update_plan and post a short design summary for ` +
          `the team. Ground it in the existing codebase and conventions.`,
        main.id,
        epic.id,
      );
      this.notify(
        'plan',
        `Architecture ready: ${epic.title}`,
        `${architect.displayName} designed the epic; the Team Lead is assigning the work.`,
        'chat',
        epic.id,
        architect.id,
      );
    }

    // 3. Lead frames the plan for the team.
    await this.actor(lead).ask(
      `You own epic “${epic.title}”. Break it into parallel tasks by stream for the team, ` +
        `note dependencies and the quality bar, and keep it concise.`,
      main.id,
      epic.id,
    );

    // 4. Decompose into stream-tagged task cards. Core builders run in parallel;
    //    docs/devops wait on the core build; verifiers (QA/review/security) wait on
    //    everything. Decomposition is IDEMPOTENT: if the Lead/PM/Architect already
    //    created a task for a stream during planning, we reuse it instead of adding
    //    a duplicate wave.
    const verifiers = specs.filter((s) => /^(qa|reviewer|security)$/.test(s.name));
    const allBuilders = specs.filter(
      (s) => s.name !== 'pm' && s.name !== 'architect' && !verifiers.includes(s),
    );
    // docs/devops depend on the code the other builders produce.
    const postStreams = new Set(['docs', 'devops']);
    const coreBuilders = allBuilders.filter((s) => !postStreams.has(s.name));
    const postBuilders = allBuilders.filter((s) => postStreams.has(s.name));
    const goal = shortGoal(content);

    // Tasks already on the board for this epic (e.g. created by the Lead/PM/
    // Architect via create_work_item during planning), indexed by stream.
    const existingByStream = new Map<string, string>();
    for (const c of this.deps.store.listChildTasks(epic.id)) {
      if (c.stream && !existingByStream.has(c.stream)) existingByStream.set(c.stream, c.id);
    }

    const makeTask = (s: Agent, opts: { verify?: boolean; dependsOn?: string[] }): string => {
      // Reuse an existing same-stream task rather than duplicating it.
      const existing = existingByStream.get(s.name);
      if (existing) {
        if (opts.dependsOn?.length) {
          const updated = this.deps.store.updateWorkItem(existing, { dependsOn: opts.dependsOn });
          if (updated)
            this.deps.bus.publish({
              type: 'workitem.updated',
              projectId: this.projectId,
              workItem: updated,
            });
        }
        if (!opts.verify) void this.onItemAssigned(existing).catch(() => undefined);
        return existing;
      }
      const task = this.deps.store.createWorkItem({
        projectId: this.projectId,
        kind: 'task',
        parentId: epic.id,
        title: opts.verify ? `[${s.name}] verify ${goal}` : `[${s.name}] ${goal}`,
        description: opts.verify
          ? `Part of epic “${epic.title}”.\n\nAcceptance criteria: ${s.displayName} sign-off — ` +
            `verify the build tasks meet the quality bar before the epic is done.`
          : `Part of epic “${epic.title}”.\n\nAcceptance criteria: deliver the ${s.displayName} ` +
            `slice of “${goal}” to a principal-engineer standard — correct, tested, and matching ` +
            `project conventions.`,
        status: opts.dependsOn?.length ? 'backlog' : 'todo',
        priority: 'medium',
        assigneeAgentId: s.id,
        stream: s.name,
        dependsOn: opts.dependsOn ?? [],
      });
      this.deps.bus.publish({
        type: 'workitem.updated',
        projectId: this.projectId,
        workItem: task,
      });
      this.emitEvent(
        lead.id,
        'system',
        opts.verify
          ? `Queued [${s.name}] verification (waits on builds)`
          : `Assigned [${s.name}] ${goal}`,
        null,
        task.id,
      );
      existingByStream.set(s.name, task.id);
      if (!opts.verify && !opts.dependsOn?.length)
        void this.onItemAssigned(task.id).catch(() => undefined);
      return task.id;
    };

    const coreTaskIds = coreBuilders.map((s) => makeTask(s, {}));
    const postTaskIds = postBuilders.map((s) => makeTask(s, { dependsOn: coreTaskIds }));
    const builderTaskIds = [...coreTaskIds, ...postTaskIds];
    for (const v of verifiers) makeTask(v, { verify: true, dependsOn: builderTaskIds });

    const builders = allBuilders;

    // 5. Post a clear, user-facing plan summary in the main chat so the user knows
    //    exactly what was decided and what happens next.
    const streamList = builders.map((b) => b.name).join(', ') || 'the team';
    const verifyNote = verifiers.length
      ? `${verifiers.map((v) => v.displayName).join(', ')} will verify against the quality bar, then I raise a PR and merge. `
      : 'I raise a PR and merge once the work meets the quality bar. ';
    const summary =
      `📋 Plan for “${epic.title}”\n\n` +
      `${goal}.\n\n` +
      `I've broken this into ${builderTaskIds.length} build task(s) across ${streamList} — ` +
      `assigned and starting now in parallel. ${verifyNote}` +
      `Follow progress on the Board; I'll keep you posted here.`;
    this.postMessage(main.id, lead, summary);
    this.notify(
      'plan',
      `Plan ready: ${epic.title}`,
      `${builderTaskIds.length} task(s) across ${streamList} — work is starting.`,
      'chat',
      epic.id,
      lead.id,
    );

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
    this.startLeadManager();
  }

  /**
   * The Team Lead proactively owns delivery: on a heartbeat (and whenever the
   * board changes) they assign ready unassigned work to the best-matching
   * specialist, and keep an eye on the team — nudging blocked agents. Agents
   * never self-assign; the Lead hands out the work.
   */
  startLeadManager(): void {
    if (this.leadStarted) return;
    this.leadStarted = true;
    const tick = (): void => {
      if (this.disposed) return;
      try {
        this.leadTick();
        this.postStatusHeartbeat();
      } catch {
        /* a manager tick must never crash the process */
      }
      this.deps.scheduler.after(this.leadTickMs, tick, this.projectId);
    };
    this.deps.scheduler.after(this.leadTickMs, tick, this.projectId);
  }

  /** Debounced immediate Lead pass, e.g. right after an unassigned card appears. */
  pokeLead(): void {
    if (this.disposed || this.leadPoke) return;
    this.leadPoke = this.deps.scheduler.after(
      50,
      () => {
        this.leadPoke = undefined;
        try {
          this.leadTick();
        } catch {
          /* swallow */
        }
      },
      this.projectId,
    );
  }

  /**
   * Live per-epic git snapshot for the Git page: branch, worktree, commits and
   * files vs base, plus the epic's PR and tasks. Runs read-only git queries in
   * each active epic clone; merged epics (clone reclaimed) report their PR only.
   */
  async gitSnapshot(): Promise<import('@shared/index').GitSnapshot> {
    const repoDir = this.project().repoDir;
    let baseBranch = 'main';
    try {
      baseBranch = await this.deps.git.currentBranch(repoDir);
    } catch {
      /* ignore */
    }
    let branches: string[] = [];
    try {
      branches = (await this.deps.git.listBranches(repoDir)).filter((b) =>
        b.startsWith('ateam/epic-'),
      );
    } catch {
      /* ignore */
    }
    const prs = this.deps.store.listPRs(this.projectId);
    const epicItems = this.deps.store
      .listWorkItems(this.projectId)
      .filter((i) => i.kind === 'epic' && i.branch);
    const epics: import('@shared/index').EpicGit[] = [];
    for (const epic of epicItems) {
      const wt = this.epicWorktrees.get(epic.id);
      const active = !!wt && fs.existsSync(wt.path);
      let commits: GitCommit[] = [];
      let files: GitFileChange[] = [];
      if (active && wt) {
        try {
          commits = await this.deps.git.commitsAhead(wt.path, baseBranch);
        } catch {
          /* ignore */
        }
        try {
          files = (await this.deps.git.filesChanged(wt.path, baseBranch)).filter(
            (f) => !f.path.startsWith('.ateam/'),
          );
        } catch {
          /* ignore */
        }
      }
      const pr = prs.find((p) => p.workItemId === epic.id) ?? null;
      // Merged epics have their clone reclaimed; fall back to the commits/files
      // captured on the PR at merge time so the detail persists.
      if ((!active || commits.length === 0) && pr && pr.commits.length > 0) commits = pr.commits;
      if ((!active || files.length === 0) && pr && pr.files.length > 0) files = pr.files;
      const tasks = this.deps.store.listChildTasks(epic.id).map((t) => ({
        id: t.id,
        title: t.title,
        stream: t.stream,
        status: t.status,
        assigneeAgentId: t.assigneeAgentId,
      }));
      epics.push({
        epicId: epic.id,
        title: epic.title,
        status: epic.status,
        branch: epic.branch,
        baseBranch: pr?.baseBranch ?? baseBranch,
        worktreePath: active && wt ? wt.path : null,
        worktreeActive: active,
        commits,
        files,
        prId: pr?.id ?? null,
        prStatus: pr?.status ?? null,
        tasks,
      });
    }
    // Most-recent epic first.
    epics.reverse();
    return { baseBranch, worktreeRoot: this.deps.git.root, branches, epics };
  }

  private leadTick(): void {
    if (this.disposed) return;
    this.assignUnassignedWork();
    this.driveAssignedWork();
    this.superviseAgents();
  }

  /**
   * Assign every ready (todo, dependency-satisfied) unassigned task to the
   * best-matching specialist. Runs in a single synchronous pass on one process,
   * so there is no claim race. Returns the number assigned.
   */
  private assignUnassignedWork(): number {
    const items = this.deps.store.listWorkItems(this.projectId);
    const status = new Map(items.map((i) => [i.id, i.status]));
    const specs = this.assignableSpecialists();
    if (specs.length === 0) return 0;
    let assigned = 0;
    for (const item of items) {
      if (item.kind === 'epic' || item.assigneeAgentId) continue;
      if (item.status !== 'todo' && item.status !== 'backlog') continue;
      const depsMet =
        item.dependsOn.length === 0 ||
        item.dependsOn.every((d) => {
          const s = status.get(d);
          return s === 'review' || s === 'done';
        });
      if (!depsMet) continue;
      const agent = this.pickAgentForItem(item, specs);
      if (!agent) continue;
      const updated = this.deps.store.updateWorkItem(item.id, { assigneeAgentId: agent.id });
      if (!updated) continue;
      this.deps.bus.publish({
        type: 'workitem.updated',
        projectId: this.projectId,
        workItem: updated,
      });
      this.emitEvent(
        this.lead().id,
        'system',
        `Assigned “${item.title}” → ${agent.displayName}`,
        null,
        item.id,
      );
      assigned += 1;
      void this.onItemAssigned(item.id).catch(() => undefined);
    }
    return assigned;
  }

  /**
   * Self-healing driver: (re)start any assigned task the Lead has handed out that
   * isn't actually running. This covers work that was assigned but never kicked
   * off, and tasks whose run stalled (agent went idle mid-flight after a crash or
   * restart). Parked tasks (assignee awaiting input, or dependency-blocked) are
   * left alone. This is what keeps the board moving without the user re-pinging.
   */
  private driveAssignedWork(): void {
    const items = this.deps.store.listWorkItems(this.projectId);
    const statusById = new Map(items.map((i) => [i.id, i.status]));
    for (const item of items) {
      if (item.kind === 'epic' || !item.assigneeAgentId) continue;
      if (item.status !== 'todo' && item.status !== 'in_progress') continue;
      if (this.running.has(item.id) || this.awaitingInput.has(item.id)) continue;
      const depsMet =
        item.dependsOn.length === 0 ||
        item.dependsOn.every((d) => {
          const s = statusById.get(d);
          return s === 'review' || s === 'done';
        });
      if (!depsMet) continue;
      const agent = this.deps.store.getAgent(item.assigneeAgentId);
      if (!agent || agent.kind !== 'specialist') continue;
      // Skip agents that are parked awaiting a decision; only resume a stalled
      // in-progress task once its agent has actually gone idle.
      if (agent.status === 'needs_input' || agent.status === 'blocked') continue;
      if (item.status === 'in_progress' && agent.status !== 'idle') continue;
      void this.runWorkItem(item.id).catch(() => undefined);
    }
  }

  /** Specialists eligible to build (excludes the design/product advisory roles). */
  private assignableSpecialists(): Agent[] {
    return this.specialists().filter((s) => s.name !== 'pm' && s.name !== 'architect');
  }

  /** Route a task to a specialist by stream tag, else to the least-loaded one. */
  private pickAgentForItem(item: WorkItem, specs: Agent[]): Agent | undefined {
    const stream = item.stream ?? /^\[(\w[\w-]*)\]/.exec(item.title)?.[1] ?? null;
    if (stream) {
      const byStream = specs.find((s) => s.name === stream);
      if (byStream) return byStream;
    }
    const all = this.deps.store.listWorkItems(this.projectId);
    const load = (a: Agent): number =>
      all.filter(
        (w) => w.assigneeAgentId === a.id && (w.status === 'todo' || w.status === 'in_progress'),
      ).length;
    return [...specs].sort((a, b) => load(a) - load(b))[0];
  }

  /** Keep an eye on the team: nudge blocked agents (throttled per agent). */
  private superviseAgents(): void {
    const now = Date.now();
    const main = this.ensureMainThread();
    const lead = this.lead();
    for (const a of this.specialists()) {
      if (a.status !== 'blocked') continue;
      const last = this.leadNudges.get(a.id) ?? 0;
      if (now - last < 60_000) continue;
      this.leadNudges.set(a.id, now);
      this.postMessage(
        main.id,
        lead,
        `@${a.displayName} you look blocked — tell me the specific blocker and what you’ve ` +
          `tried, and I’ll unblock you or pull the right people into a quick discussion.`,
      );
    }
  }

  /**
   * While epics are in flight, the Team Lead posts a concise, throttled status
   * to main chat so ownership is visible: progress per active epic, who's on
   * what, and what's next. Deduped by signature so an unchanged board stays
   * quiet, and rate-limited by STATUS_HEARTBEAT_MS.
   */
  private postStatusHeartbeat(): void {
    const now = Date.now();
    if (now - this.lastStatusAt < this.statusHeartbeatMs) return;
    const items = this.deps.store.listWorkItems(this.projectId);
    const epics = items.filter((i) => i.kind === 'epic' && i.status === 'in_progress');
    if (epics.length === 0) return;
    const nameById = new Map(this.deps.store.listAgents(this.projectId).map((a) => [a.id, a]));

    const lines: string[] = [];
    for (const epic of epics) {
      const tasks = items.filter((i) => i.parentId === epic.id);
      const done = tasks.filter((t) => t.status === 'done' || t.status === 'review').length;
      const inProgress = tasks.filter((t) => t.status === 'in_progress');
      const todo = tasks.filter((t) => t.status === 'todo' || t.status === 'backlog');
      lines.push(
        `**${epic.title}** — ${epic.progress ?? 0}% (${done}/${tasks.length} tasks landed)`,
      );
      for (const t of inProgress) {
        const who = t.assigneeAgentId ? nameById.get(t.assigneeAgentId)?.displayName : null;
        lines.push(`  • ${who ? `${who}: ` : ''}${t.title}`);
      }
      if (todo.length > 0) lines.push(`  • next up: ${todo.length} task(s) queued`);
    }
    const body = lines.join('\n');

    // Skip if nothing meaningful changed since the last heartbeat.
    const sig = body;
    if (sig === this.lastStatusSig) return;
    this.lastStatusAt = now;
    this.lastStatusSig = sig;
    this.postMessage(this.ensureMainThread().id, this.lead(), `📋 **Status update**\n${body}`);
  }

  /**
   * On server boot, analyze persisted state and resume interrupted work. All
   * in-memory runtime (agent sessions, epic worktrees, live agent statuses) is
   * lost across a restart, so we reconcile the DB back to a runnable state and
   * re-drive the board: clear stale statuses, rebuild epic worktrees, promote any
   * dependency-satisfied tasks, and requeue interrupted/assigned work.
   */
  async resumeWork(): Promise<void> {
    const items = this.deps.store.listWorkItems(this.projectId);

    // 1. Clear stale runtime statuses left behind by the previous (dead) process.
    for (const agent of this.deps.store.listAgents(this.projectId)) {
      if (agent.status === 'working' || agent.status === 'needs_input') {
        this.setStatus(agent.id, 'idle');
      }
    }

    // 2. Rebuild isolated worktrees for epics with open work, so resumed tasks
    //    commit on their epic branch instead of leaking into the main repo.
    const openEpics = items.filter((i) => i.kind === 'epic' && i.status !== 'done');
    for (const epic of openEpics) {
      try {
        const wt = await this.deps.git.createEpicWorktree(
          this.project().repoDir,
          this.projectId,
          epic.id,
        );
        this.epicWorktrees.set(epic.id, wt);
      } catch {
        /* best-effort: fall back to the repo dir if git is unavailable */
      }
      this.maybePromoteDependents(epic.id);
    }

    // 3. Requeue work. Items cut off mid-run (in_progress) are reset to todo so
    //    they re-run cleanly; assigned todo items get picked up again.
    let resumed = 0;
    for (const item of this.deps.store.listWorkItems(this.projectId)) {
      if (item.kind === 'epic' || !item.assigneeAgentId) continue;
      if (item.status === 'in_progress') this.moveItem(item.id, 'todo');
      if (item.status === 'in_progress' || item.status === 'todo') {
        resumed += 1;
        void this.onItemAssigned(item.id).catch(() => undefined);
      }
    }

    if (resumed > 0) {
      this.emitEvent(
        this.lead().id,
        'system',
        `Resumed ${resumed} in-flight task(s) after restart`,
        null,
        null,
      );
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
    if (item.status === 'done' || item.status === 'review') return;
    // One in-flight run per item. A stalled 'in_progress' item (no active run) is
    // allowed through so the manager can resume it after a crash/restart.
    if (this.running.has(workItemId)) return;
    this.running.add(workItemId);
    try {
      await this.runWorkItemInner(item.id, agent);
    } finally {
      this.running.delete(workItemId);
    }
  }

  private async runWorkItemInner(workItemId: string, agent: Agent): Promise<void> {
    const item = this.deps.store.getWorkItem(workItemId);
    if (!item) return;

    this.moveItem(item.id, 'in_progress');
    this.setProgress(item.id, Math.max(10, item.progress), agent);
    const main = this.ensureMainThread();
    const startTask = this.deps.store.upsertTask({
      projectId: this.projectId,
      agentId: agent.id,
      workItemId: item.id,
      title: item.title,
      status: 'doing',
    });
    this.deps.bus.publish({ type: 'task.updated', projectId: this.projectId, task: startTask });

    // Run in the epic's isolated worktree when this task belongs to an epic.
    const worktree = item.parentId ? this.epicWorktrees.get(item.parentId) : undefined;
    const cwd = worktree?.path;
    const basePrompt =
      `The Team Lead assigned you this task. Work on it and report progress to the team.\n\n` +
      `Task: ${item.title}\nDetails: ${item.description || '(none)'}\n` +
      (worktree
        ? `You are on branch ${worktree.branch} in an isolated worktree. Create/edit real files ` +
          `here using relative paths.\n`
        : '') +
      `When done, summarize what you did and CITE EVIDENCE: list the exact files you ` +
      `created or edited and how you verified the work (tests run, commands, checks). ` +
      `Do not claim completion unless you actually created or edited real files.`;

    // Build tasks must produce real, committable changes — an agent that only
    // narrates has not done the work. Verifier streams (qa/reviewer/security)
    // legitimately may only sign off, so they are not gated.
    const isVerifier = /^(qa|reviewer|security)$/.test(item.stream ?? '');
    const gate = !!worktree && !isVerifier;
    const MAX_ATTEMPTS = 2;

    let summary = '';
    let produced = !gate;
    for (let attempt = 1; attempt <= (gate ? MAX_ATTEMPTS : 1); attempt++) {
      const firm =
        attempt > 1
          ? `\n\nYour previous attempt produced NO file changes in the working directory. You ` +
            `MUST create or edit real files (relative paths) before you summarize.`
          : '';
      summary = await this.actor(agent).ask(basePrompt + firm, main.id, item.id, cwd);
      if (!gate || !worktree) break;
      produced = await this.deps.git.hasRealChanges(worktree.path);
      if (produced) break;
      this.emitEvent(
        agent.id,
        'git',
        `Produced no file changes (attempt ${attempt}/${MAX_ATTEMPTS})`,
        null,
        item.id,
      );
    }

    // Empty build after the retry budget → do NOT mark it done; flag + escalate to
    // the user for guidance. The task stays in progress so the epic can't silently
    // "complete" with no deliverable.
    if (gate && worktree && !produced) {
      this.setStatus(agent.id, 'needs_input');
      this.awaitingInput.add(item.id);
      this.emitEvent(
        agent.id,
        'system',
        `“${item.title}” produced no code after ${MAX_ATTEMPTS} attempts — needs guidance`,
        null,
        item.id,
      );
      this.notify(
        'question',
        `Task blocked: ${item.title}`,
        `${agent.displayName} could not produce deliverable changes and needs your guidance.`,
        'board',
        item.id,
        agent.id,
      );
      void this.raiseQuestion(
        agent.id,
        `${agent.displayName} produced no code for “${item.title}” after ${MAX_ATTEMPTS} attempts. How should we proceed?`,
        ['Retry', 'Skip this task'],
      ).then((ans) => {
        this.awaitingInput.delete(item.id);
        this.setStatus(agent.id, 'idle');
        if (ans.toLowerCase().startsWith('skip')) {
          this.moveItem(item.id, 'done');
          this.maybeFinishEpic(item.parentId);
        } else {
          // Retry: put it back in the queue and let the manager re-drive it.
          this.moveItem(item.id, 'todo');
          this.pokeLead();
        }
      });
      return;
    }

    // Record an audit note and commit the task's work on the epic branch.
    let completion: { branch: string; hash: string | null; files: GitFileChange[] } | null = null;
    if (worktree) {
      try {
        const noteDir = path.join(worktree.path, '.ateam', 'tasks');
        fs.mkdirSync(noteDir, { recursive: true });
        fs.writeFileSync(
          path.join(noteDir, `${item.id}.md`),
          `# ${item.title}\n\n- Stream: ${item.stream ?? '-'}\n- Agent: ${agent.displayName}\n\n${summary}\n`,
        );
        const res = await this.deps.git.commitWork(
          worktree.path,
          `task(${item.stream ?? 'task'}): ${item.title}`,
        );
        const files =
          res.committed && res.hash ? await this.deps.git.commitFiles(worktree.path, res.hash) : [];
        completion = { branch: worktree.branch, hash: res.committed ? res.hash : null, files };
        if (res.committed)
          this.emitEvent(
            agent.id,
            'git',
            `Committed ${res.hash?.slice(0, 8)} on ${worktree.branch}`,
            { branch: worktree.branch, hash: res.hash, files },
            item.id,
          );
      } catch (err) {
        this.emitEvent(
          agent.id,
          'git',
          `Commit skipped: ${err instanceof Error ? err.message : String(err)}`,
          null,
          item.id,
        );
      }
    }

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
    this.setProgress(item.id, 100, agent);
    // Post a structured, evidence-backed completion report to the team so the
    // branch/commit/files are visible and “done” can't hide an empty branch.
    this.postTaskCompletion(agent, item, completion, summary, isVerifier);
    this.notify(
      'task',
      `Task complete: ${item.title}`,
      summary.slice(0, 200),
      'board',
      item.id,
      agent.id,
    );
    // If this was a fix task for review comments, mark them resolved.
    this.resolveCommentsForItem(item.id);
    // A finished task may unblock dependency-gated siblings (e.g. QA/review).
    this.maybePromoteDependents(item.parentId);
    // When every task in the epic is reviewed, raise a PR and run review-to-merge.
    this.maybeFinishEpic(item.parentId);
    await this.pullNext(agent.id);
  }

  /** Render a `+a / −r` line for a changed file (binary shows `bin`). */
  private fileLine(f: GitFileChange): string {
    const stat = f.added < 0 || f.removed < 0 ? 'bin' : `+${f.added} / −${f.removed}`;
    return `- \`${f.path}\` (${stat})`;
  }

  /**
   * Post the mandatory completion report for a task: branch, commit and the
   * exact files changed, plus the agent's evidence. Verifier/no-code tasks say
   * so honestly instead of implying a build landed.
   */
  private postTaskCompletion(
    agent: Agent,
    item: WorkItem,
    completion: { branch: string; hash: string | null; files: GitFileChange[] } | null,
    summary: string,
    isVerifier: boolean,
  ): void {
    const main = this.ensureMainThread();
    // Exclude ateam bookkeeping from the deliverable evidence.
    const files = (completion?.files ?? []).filter((f) => !f.path.startsWith('.ateam/'));
    const lines: string[] = [];
    const header =
      completion && !completion.hash && isVerifier
        ? `### ✅ Task complete — ${item.title} _(verification — no code changes)_`
        : `### ✅ Task complete — ${item.title}`;
    lines.push(header);
    lines.push(
      `**Agent:** ${agent.emoji} ${agent.displayName} · **Stream:** ${item.stream ?? '—'}`,
    );
    if (completion?.branch) lines.push(`**Branch:** \`${completion.branch}\``);
    if (completion?.hash) {
      lines.push(
        `**Commit:** \`${completion.hash.slice(0, 8)}\` — task(${item.stream ?? 'task'}): ${item.title}`,
      );
    }
    if (files.length > 0) {
      lines.push(`**Files changed (${files.length}):**`);
      for (const f of files.slice(0, 20)) lines.push(this.fileLine(f));
      if (files.length > 20) lines.push(`- …and ${files.length - 20} more`);
    } else if (!isVerifier && completion) {
      lines.push(`**Files changed:** _none_`);
    }
    lines.push('');
    lines.push('**Evidence**');
    lines.push(summary.trim() || '_(no summary provided)_');
    this.postMessage(main.id, agent, lines.join('\n'));
  }

  /** Post the epic-level merge report (branch, commit count, files) to the team. */
  private postEpicCompletion(
    epic: WorkItem,
    branch: string,
    base: string,
    commits: GitCommit[],
    files: GitFileChange[],
  ): void {
    const main = this.ensureMainThread();
    const lead = this.lead();
    const lines: string[] = [];
    lines.push(`### 🚀 Epic merged — ${epic.title}`);
    lines.push(
      `**Branch:** \`${branch || '—'}\` → \`${base || 'main'}\` · ` +
        `**${commits.length}** commit${commits.length === 1 ? '' : 's'} · ` +
        `**${files.length}** file${files.length === 1 ? '' : 's'} changed`,
    );
    if (commits.length > 0) {
      lines.push('**Commits:**');
      for (const c of commits.slice(0, 15)) lines.push(`- \`${c.hash.slice(0, 8)}\` ${c.subject}`);
      if (commits.length > 15) lines.push(`- …and ${commits.length - 15} more`);
    }
    if (files.length > 0) {
      lines.push('**Files:**');
      for (const f of files.slice(0, 20)) lines.push(this.fileLine(f));
      if (files.length > 20) lines.push(`- …and ${files.length - 20} more`);
    }
    this.postMessage(main.id, lead, lines.join('\n'));
  }

  /** Promote backlog tasks whose dependencies are all satisfied (review/done). */
  private maybePromoteDependents(parentId: string | null): void {
    if (!parentId) return;
    const siblings = this.deps.store.listChildTasks(parentId);
    const satisfied = new Set(
      siblings.filter((s) => s.status === 'review' || s.status === 'done').map((s) => s.id),
    );
    for (const t of siblings) {
      if (
        t.status === 'backlog' &&
        t.dependsOn.length > 0 &&
        t.dependsOn.every((d) => satisfied.has(d))
      ) {
        this.moveItem(t.id, 'todo');
        this.emitEvent(
          t.assigneeAgentId,
          'system',
          `Dependencies met — starting ${t.title}`,
          null,
          t.id,
        );
        if (t.assigneeAgentId) void this.onItemAssigned(t.id).catch(() => undefined);
      }
    }
  }

  /* ---------------------------------------------- PR + review + iterate */

  private findReviewer(lead: Agent): Agent {
    const specialists = this.specialists();
    // The Architect designed the epic, so they're the natural PR gatekeeper.
    for (const name of ['architect', 'reviewer', 'qa', 'security']) {
      const found = specialists.find((s) => s.name === name);
      if (found) return found;
    }
    return specialists[0] ?? lead;
  }

  /** The specialist that owns a stream (by name), if any. */
  private findAgentByStream(stream: string | null): Agent | null {
    if (!stream) return null;
    const needle = stream.trim().toLowerCase();
    return this.specialists().find((s) => s.name.toLowerCase() === needle) ?? null;
  }

  /** If every task in the epic is reviewed, open a PR and drive review-to-merge. */
  private maybeFinishEpic(parentId: string | null): void {
    if (!parentId) return;
    const epic = this.deps.store.getWorkItem(parentId);
    if (!epic || epic.kind !== 'epic' || epic.status === 'done') return;
    if (this.epicReviewing.has(parentId)) return;
    const children = this.deps.store.listChildTasks(parentId);
    if (children.length === 0) return;
    if (!children.every((c) => c.status === 'review' || c.status === 'done')) return;
    this.epicReviewing.add(parentId);
    const p = this.runEpicReview(epic).finally(() => {
      this.epicReviewing.delete(parentId);
      this.pendingReviews.delete(p);
    });
    this.pendingReviews.add(p);
    void p;
  }

  private async runEpicReview(epic: WorkItem): Promise<void> {
    if (this.disposed) return;
    const iter = (this.epicReviewIter.get(epic.id) ?? 0) + 1;
    this.epicReviewIter.set(epic.id, iter);
    const main = this.ensureMainThread();
    const lead = this.lead();
    const repoDir = this.project().repoDir;
    const branch = epic.branch ?? '';
    const wt = this.epicWorktrees.get(epic.id);

    if (this.deps.store.getWorkItem(epic.id)?.status !== 'review') this.moveItem(epic.id, 'review');

    let diff = '';
    if (branch && wt) {
      try {
        const base = await this.deps.git.currentBranch(repoDir);
        diff = await this.deps.git.branchDiff(wt.path, base);
      } catch {
        /* ignore */
      }
    }

    const reviewer = this.findReviewer(lead);

    // Raise the PR once; reuse it across review rounds.
    let prId = this.epicPr.get(epic.id);
    if (!prId) {
      let base = 'main';
      try {
        base = await this.deps.git.currentBranch(repoDir);
      } catch {
        /* ignore */
      }
      const pr = this.deps.store.createPR({
        projectId: this.projectId,
        workItemId: epic.id,
        authorAgentId: lead.id,
        title: `PR: ${epic.title}`,
        description: `Epic “${epic.title}” ready for review.`,
        branch,
        baseBranch: base,
        diff,
      });
      prId = pr.id;
      this.epicPr.set(epic.id, prId);
      this.emitEvent(lead.id, 'pull_request', `Raised PR for “${epic.title}”`, null, epic.id);
      this.notify(
        'pr',
        `PR opened: ${epic.title}`,
        `${reviewer.displayName} will review the changes.`,
        'git',
        epic.id,
        lead.id,
      );
    } else {
      this.deps.store.updatePR(prId, { status: 'open', diff });
    }
    const withReviewer = this.deps.store.updatePR(prId, {
      reviewerAgentId: reviewer.id,
      status: 'open',
    });
    if (withReviewer)
      this.deps.bus.publish({
        type: 'pull_request.updated',
        projectId: this.projectId,
        pr: withReviewer,
      });

    // No independent reviewer available → Lead self-approves and merges.
    if (reviewer.id === lead.id) {
      await this.approveAndMerge(epic, prId, lead, repoDir, branch);
      return;
    }

    // The reviewer (Architect) inspects the diff and files routed comments via
    // the add_review_comment tool. We resolve the PR from reviewContext during
    // the ask.
    this.reviewContext.set(reviewer.id, { epicId: epic.id, prId });
    const prompt =
      `Please review the pull request for epic “${epic.title}” against the design and the ` +
      `quality bar.\n\n` +
      `Diff:\n${diff.slice(0, 6000) || '(no textual diff)'}\n\n` +
      `For every issue, call add_review_comment(body, targetStream) routed to the responsible ` +
      `stream. If it meets the bar, leave no comments and it will be approved.`;
    try {
      await this.actor(reviewer).ask(prompt, main.id, epic.id, wt?.path);
    } finally {
      this.reviewContext.delete(reviewer.id);
    }

    const open = this.deps.store.listPrComments(prId).filter((c) => c.status === 'open');

    // Clean bill of health: the Team Lead (sole approver) merges.
    if (open.length === 0) {
      await this.approveAndMerge(epic, prId, lead, repoDir, branch);
      return;
    }

    const changed = this.deps.store.updatePR(prId, { status: 'changes_requested' });
    if (changed)
      this.deps.bus.publish({
        type: 'pull_request.updated',
        projectId: this.projectId,
        pr: changed,
      });
    this.emitEvent(
      reviewer.id,
      'pull_request',
      `Requested changes: ${open.length} comment(s)`,
      null,
      epic.id,
    );
    this.notify(
      'review',
      `Changes requested: ${epic.title}`,
      `${reviewer.displayName} left ${open.length} comment(s); the Team Lead is assigning fixes.`,
      'git',
      epic.id,
      reviewer.id,
    );

    // Deadlock guard: after the cap, the Lead resolves outstanding comments and
    // merges rather than letting the epic hang forever.
    if (iter >= ProjectOrchestrator.MAX_REVIEW_ITER) {
      for (const c of open) this.resolveComment(c.id);
      this.emitEvent(
        lead.id,
        'pull_request',
        `Merging after ${iter} review rounds (cap reached)`,
        null,
        epic.id,
      );
      await this.approveAndMerge(epic, prId, lead, repoDir, branch);
      return;
    }

    // The Team Lead turns each open comment into a fix task assigned to the
    // responsible stream. When those tasks land, comments resolve and review
    // re-runs automatically.
    for (const c of open) {
      if (c.workItemId) continue;
      const target =
        (c.targetAgentId ? this.deps.store.getAgent(c.targetAgentId) : null) ??
        this.findAgentByStream(c.targetStream) ??
        this.pickAgentForItem({ stream: c.targetStream } as WorkItem, this.assignableSpecialists());
      const stream = c.targetStream ?? target?.name ?? null;
      const fix = this.deps.store.createWorkItem({
        projectId: this.projectId,
        kind: 'task',
        parentId: epic.id,
        title: `[${stream ?? 'fix'}] fix: ${c.body.slice(0, 60)}`,
        description: `Review comment on “${epic.title}”:\n\n${c.body}`,
        status: 'todo',
        priority: 'high',
        assigneeAgentId: target?.id ?? null,
        stream,
      });
      this.deps.store.updatePrComment(c.id, {
        workItemId: fix.id,
        targetAgentId: target?.id ?? null,
      });
      this.deps.bus.publish({
        type: 'workitem.updated',
        projectId: this.projectId,
        workItem: fix,
      });
      this.emitEvent(
        lead.id,
        'system',
        `Assigned fix “${fix.title}”${target ? ` → ${target.displayName}` : ''}`,
        null,
        fix.id,
      );
      if (target) void this.onItemAssigned(fix.id).catch(() => undefined);
      else this.pokeLead();
    }
  }

  /** Mark a review comment resolved and broadcast it. */
  private resolveComment(commentId: string): void {
    const updated = this.deps.store.updatePrComment(commentId, { status: 'resolved' });
    if (updated)
      this.deps.bus.publish({
        type: 'pr_comment.updated',
        projectId: this.projectId,
        comment: updated,
      });
  }

  /** When a fix task lands, resolve the comments it addressed. */
  private resolveCommentsForItem(workItemId: string): void {
    for (const c of this.deps.store.commentsForWorkItem(workItemId)) {
      if (c.status === 'open') this.resolveComment(c.id);
    }
  }

  private async approveAndMerge(
    epic: WorkItem,
    prId: string,
    approver: Agent,
    repoDir: string,
    branch: string,
  ): Promise<void> {
    const approved = this.deps.store.updatePR(prId, { status: 'approved' });
    if (approved)
      this.deps.bus.publish({
        type: 'pull_request.updated',
        projectId: this.projectId,
        pr: approved,
      });
    this.emitEvent(approver.id, 'pull_request', `Approved PR for “${epic.title}”`, null, epic.id);

    if (branch) {
      try {
        const wt = this.epicWorktrees.get(epic.id);
        const m = await this.deps.git.mergeEpic(repoDir, wt?.path ?? '', branch);
        this.emitEvent(
          approver.id,
          'git',
          m.ok ? m.detail : `Merge failed: ${m.detail}`,
          null,
          epic.id,
        );
      } catch (err) {
        this.emitEvent(
          approver.id,
          'git',
          `Merge error: ${err instanceof Error ? err.message : String(err)}`,
          null,
          epic.id,
        );
      }
    }
    const merged = this.deps.store.updatePR(prId, { status: 'merged' });
    if (merged)
      this.deps.bus.publish({
        type: 'pull_request.updated',
        projectId: this.projectId,
        pr: merged,
      });

    for (const c of this.deps.store.listChildTasks(epic.id)) {
      if (c.status !== 'done') this.moveItem(c.id, 'done');
    }
    this.moveItem(epic.id, 'done');
    this.setProgress(epic.id, 100);
    this.emitEvent(
      this.lead().id,
      'system',
      `Epic “${epic.title}” merged and closed`,
      null,
      epic.id,
    );
    this.notify(
      'merge',
      `Epic merged: ${epic.title}`,
      'All tasks reviewed and merged. The epic is complete.',
      'git',
      epic.id,
      this.lead().id,
    );
    // Epic-level completion report: total commits + files that landed on the
    // branch, so the team + user see exactly what was merged. Posted after the
    // merge notification so it never delays the completion signal.
    try {
      const wtStats = this.epicWorktrees.get(epic.id);
      let base = '';
      try {
        base = await this.deps.git.currentBranch(repoDir);
      } catch {
        /* ignore */
      }
      let commits: GitCommit[] = [];
      let files: GitFileChange[] = [];
      if (wtStats) {
        commits = await this.deps.git.commitsAhead(wtStats.path, base);
        files = (await this.deps.git.filesChanged(wtStats.path, base)).filter(
          (f) => !f.path.startsWith('.ateam/'),
        );
      }
      // Persist the landed commits/files on the PR so the Git page keeps full
      // detail after the epic clone is reclaimed.
      const withStats = this.deps.store.updatePR(prId, { commits, files });
      if (withStats)
        this.deps.bus.publish({
          type: 'pull_request.updated',
          projectId: this.projectId,
          pr: withStats,
        });
      this.postEpicCompletion(epic, branch, base, commits, files);
    } catch {
      /* reporting is best-effort */
    }

    // Reclaim the epic's isolated worktree now that it is merged + closed.
    const wt = this.epicWorktrees.get(epic.id);
    if (wt) {
      try {
        await this.deps.git.removeWorktree(repoDir, wt.path);
      } catch {
        /* best-effort cleanup */
      }
      this.epicWorktrees.delete(epic.id);
    }
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
      updateProgress: (input) => {
        const target =
          input.workItemId ??
          this.deps.store
            .listWorkItems(pid)
            .find((w) => w.assigneeAgentId === agent.id && w.status === 'in_progress')?.id ??
          null;
        if (!target) return { ok: false };
        this.setProgress(target, input.progress, agent, input.note);
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
      addReviewComment: (input) => {
        const ctx = this.reviewContext.get(agent.id);
        if (!ctx) return { ok: false };
        // Dedupe by body so re-reviews of the same diff converge instead of piling up.
        const existing = this.deps.store.listPrComments(ctx.prId);
        if (existing.some((c) => c.body === input.body)) return { ok: true };
        const targetStream = input.targetStream?.trim() || null;
        const targetAgent = this.findAgentByStream(targetStream);
        const comment = this.deps.store.createPrComment({
          projectId: pid,
          prId: ctx.prId,
          body: input.body,
          targetStream,
          targetAgentId: targetAgent?.id ?? null,
          status: 'open',
        });
        this.deps.bus.publish({
          type: 'pr_comment.updated',
          projectId: pid,
          comment,
        });
        this.emitEvent(
          agent.id,
          'pull_request',
          `Review comment${targetStream ? ` [${targetStream}]` : ''}: ${input.body.slice(0, 80)}`,
          null,
          ctx.epicId,
        );
        return { ok: true };
      },
      writeNote: (input) => {
        const note = this.deps.store.appendNote({
          projectId: pid,
          agentId: agent.id,
          workItemId: input.workItemId ?? null,
          content: input.content,
        });
        this.deps.bus.publish({
          type: 'agent_note.appended',
          projectId: pid,
          agentId: agent.id,
          note,
        });
        this.emitEvent(
          agent.id,
          'system',
          `Noted: ${input.content.slice(0, 80)}`,
          null,
          note.workItemId,
        );
        return { ok: true };
      },
      updatePlan: (input) => {
        const plan = this.deps.store.setPlan({
          projectId: pid,
          agentId: agent.id,
          content: input.content,
        });
        this.deps.bus.publish({
          type: 'agent_plan.updated',
          projectId: pid,
          agentId: agent.id,
          plan,
        });
        this.emitEvent(agent.id, 'system', 'Updated its plan', null, null);
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

  private moveItem(workItemId: string, status: WorkItem['status']): void {
    const updated = this.deps.store.updateWorkItem(workItemId, { status });
    if (updated)
      this.deps.bus.publish({
        type: 'workitem.updated',
        projectId: this.projectId,
        workItem: updated,
      });
  }

  /** Update a work item's completion %, roll it up to its epic, and notify milestones. */
  private setProgress(workItemId: string, value: number, agent?: Agent, note?: string): void {
    const before = this.deps.store.getWorkItem(workItemId);
    const clamped = Math.max(0, Math.min(100, Math.round(value)));
    if (before && before.progress === clamped && !note) {
      if (before.parentId) this.recomputeEpicProgress(before.parentId);
      return;
    }
    const updated = this.deps.store.updateWorkItem(workItemId, { progress: clamped });
    if (!updated) return;
    this.deps.bus.publish({
      type: 'workitem.updated',
      projectId: this.projectId,
      workItem: updated,
    });
    if (updated.parentId) this.recomputeEpicProgress(updated.parentId);
    // Notify only on meaningful milestones (an explicit note, or completion) so
    // the panel stays signal-rich rather than logging every tick.
    if (note) {
      this.notify(
        'progress',
        `${updated.title} · ${clamped}%`,
        note,
        'board',
        workItemId,
        agent?.id ?? null,
      );
    }
  }

  /** Roll an epic's progress up from the average of its child tasks. */
  private recomputeEpicProgress(epicId: string): void {
    const children = this.deps.store.listChildTasks(epicId);
    if (children.length === 0) return;
    const avg = Math.round(
      children.reduce((s, c) => s + (c.status === 'done' ? 100 : c.progress), 0) / children.length,
    );
    const epic = this.deps.store.getWorkItem(epicId);
    if (!epic || epic.progress === avg) return;
    const updated = this.deps.store.updateWorkItem(epicId, { progress: avg });
    if (updated)
      this.deps.bus.publish({
        type: 'workitem.updated',
        projectId: this.projectId,
        workItem: updated,
      });
  }

  /** Record a user-facing notification and broadcast it. */
  notify(
    type: NotificationType,
    title: string,
    body: string,
    link: string,
    workItemId: string | null = null,
    agentId: string | null = null,
  ): void {
    const notification = this.deps.store.createNotification({
      projectId: this.projectId,
      type,
      title,
      body,
      link,
      workItemId,
      agentId,
    });
    this.deps.bus.publish({
      type: 'notification.created',
      projectId: this.projectId,
      notification,
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

  async handlePermission(ask: PermissionAsk, agent?: Agent): Promise<'approve' | 'reject'> {
    const project = this.project();
    // The Team Lead orchestrates and reviews — it must NEVER modify files or run
    // mutating shell itself. All code is produced by specialists in their epic
    // clones; the Lead's edits would land in the main checkout, orphaned. Reads
    // are fine (it may inspect the repo to plan).
    if (agent?.kind === 'lead' && ask.kind !== 'read') return 'reject';
    if (project.settings.approvalMode === 'auto-workspace') {
      if (ask.kind === 'read') return 'approve';
      // Writes/shell are allowed inside the project checkout OR inside a managed
      // epic clone (under the worktree root) — specialists work in their clone,
      // which lives outside repoDir.
      const inRepo = isInsideWorkspace(project.repoDir, ask.fileName);
      const inClone = isInsideWorkspace(this.deps.git.root, ask.fileName);
      return inRepo || inClone ? 'approve' : 'reject';
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
    // A specialist's question goes to the Team Lead first — the Lead owns the
    // conversation with the user. The Lead decides from product/tech direction
    // and answers, and only escalates to the human when it genuinely needs a
    // decision only the user can make.
    if (agent.kind === 'specialist') {
      this.setStatus(agent.id, 'needs_input');
      try {
        return await this.resolveViaLead(agent, ask);
      } finally {
        this.setStatus(agent.id, 'working');
      }
    }
    this.setStatus(agent.id, 'needs_input');
    const answer = await this.raiseQuestion(agent.id, ask.question, ask.choices);
    this.setStatus(agent.id, 'working');
    return answer;
  }

  /**
   * The Team Lead resolves a specialist's blocking question. The Lead answers
   * directly when it can, or replies `ESCALATE: <question>` to defer to the user
   * — in which case we surface that question and relay the human's answer back to
   * the specialist. Everything is posted to main chat so ownership stays visible.
   */
  private async resolveViaLead(agent: Agent, ask: UserInputAsk): Promise<string> {
    const lead = this.lead();
    const main = this.ensureMainThread();
    const choicesTxt = ask.choices?.length ? `\nOptions: ${ask.choices.join(' | ')}` : '';
    this.emitEvent(agent.id, 'escalation', `Asked the Team Lead: ${ask.question}`, null, null);
    const prompt =
      `${agent.displayName} is blocked and needs a decision to continue:\n\n` +
      `“${ask.question}”${choicesTxt}\n\n` +
      `As Team Lead you own delivery and the user relationship. Resolve this so the work ` +
      `can proceed. If you can decide from the product/technical direction, reply with a ` +
      `clear, actionable answer addressed to ${agent.displayName} (name the option to take if ` +
      `there are choices). Only if this genuinely requires the human user's decision, reply ` +
      `with exactly “ESCALATE: <the specific question to ask the user>”. Keep it concise.`;
    let decision: string;
    try {
      decision = (await this.actor(lead).ask(prompt, main.id, null)).trim();
    } catch {
      decision = '';
    }
    const esc = /ESCALATE:\s*([\s\S]+)/i.exec(decision);
    if (esc || !decision) {
      const userQuestion = esc ? (esc[1]?.trim() ?? ask.question) : ask.question;
      const answer = await this.raiseQuestion(agent.id, userQuestion, ask.choices);
      this.postMessage(
        main.id,
        lead,
        `@${agent.displayName} the user says: ${answer}. Please proceed on that basis.`,
      );
      return answer;
    }
    return decision;
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
    this.notify('question', 'Your input is needed', question, 'chat', null, agentId);
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
    this.disposed = true;
    this.leadPoke?.();
    await Promise.allSettled([...this.pendingReviews]);
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

  /** Re-arm scheduled work and resume interrupted work across known projects (startup). */
  resumeAll(projectIds: string[]): void {
    for (const pid of projectIds) {
      const o = this.get(pid);
      void o.resumeWork().catch(() => undefined);
    }
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
    this.deps.git.removeProjectWorktrees(projectId);
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
