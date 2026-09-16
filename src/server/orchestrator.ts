import path from 'node:path';
import fs from 'node:fs';
import {
  runProjectBuild,
  runProjectTests,
  runAcceptanceProbe,
  ensureDependencies,
} from './qaGate.js';
import { sanitizeDag } from './dag.js';
import { planStallRecovery, boardHasLiveWork } from './stallRecovery.js';
import { reviewBudgetDecision } from './reviewBudget.js';
import { mentionsAgent, stripMention } from './mention.js';
import { scopeStreams, pickBrownfieldBuilders } from './streamScope.js';
import {
  classifyComplexity,
  parseDesignBreakdown,
  type Complexity,
} from './complexity.js';
import {
  detectConstraints,
  checkClone,
  summarizeViolations,
  describeConstraints,
  type Constraint,
} from './constraints.js';
import {
  assembleChecks,
  makeReport,
  overrideReport,
  requiredChecks,
  summarizeReport,
  type CheckStatus,
  type GateScope,
} from './verification.js';
import type { Agent, NotificationType, Project, Thread, WorkItem } from '@shared/index';
import type { AgentTask, AgentTaskStatus } from '@shared/index';
import type { AcceptanceCriterion, CriterionStatus } from '@shared/index';
import type { GitFileChange } from '@shared/index';
import type { GitCommit } from '@shared/index';
import type { PrComment } from '@shared/index';
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
import { discoverSkills, scopedDisabledSkills, skillDirectories } from './agents/skillScanner.js';
import type { Cancel, SchedulerService } from './scheduler.js';
import type { GitService } from './git.js';
import type { SessionRecorder } from './sessionRecorder.js';

interface Deps {
  store: Store;
  bus: Bus;
  adapter: CopilotAdapter;
  skillHomeRoots: string[];
  scheduler: SchedulerService;
  git: GitService;
  recorder: SessionRecorder;
}

function isInsideWorkspace(repoDir: string, filePath: string | undefined): boolean {
  if (!filePath) return true;
  const root = path.resolve(repoDir);
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath);
  const rel = path.relative(root, abs);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

const GROUPCHAT_RE = /\[\[REQUEST_GROUPCHAT:\s*([^\]]+)\]\]/i;

/** Sentinel returned by {@link withTimeout} when the wrapped promise does not settle in time. */
const TIMED_OUT = Symbol('timed-out');

/**
 * Race a promise against a timeout. The underlying work is NOT cancelled (LLM
 * turns cannot be aborted mid-flight) — the caller simply stops waiting and
 * treats the result as unavailable. Used to bound the design turn so dispatch is
 * never held past the budget.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), Math.max(1, ms));
  });
  return Promise.race([p.then((v) => v).finally(() => clearTimeout(timer)), timeout]);
}

/**
 * One independent, concurrent actor per agent: owns the agent's own Copilot
 * session (grounded with environment/project/team context) and a serialized
 * mailbox so a single agent isn't asked twice at once. Different actors run in
 * parallel - the team is truly async.
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
    const recording = this.orch.recordingActive;
    if (recording) {
      const wi = workItemId ? this.orch.deps.store.getWorkItem(workItemId) : null;
      this.orch.deps.recorder.begin({
        projectId: project.id,
        agentId: this.agent.id,
        agentName: this.agent.displayName,
        agentKind: this.agent.kind,
        workItemId,
        workItemTitle: wi?.title ?? null,
        threadId,
        cwd,
        model: this.agent.model || project.settings.defaultModel,
        prompt,
      });
    }
    try {
      const startedAt = Date.now();
      let text: string;
      try {
        text = await session.ask(prompt, placeholder.id);
      } finally {
        this.orch.recordUsage(this.agent.id, workItemId, {
          timeMs: Date.now() - startedAt,
          turns: 1,
        });
      }
      const reply = text.trim();
      if (recording) this.orch.deps.recorder.end(this.agent.id, reply);
      if (reply) {
        this.orch.finalizeMessage(placeholder.id, reply);
        await this.orch.maybeHandleGroupChatRequest(this.agent, reply, workItemId);
      } else {
        // Tool-only turn (e.g. the agent acted via app tools): drop the empty
        // placeholder instead of leaving a dangling “…” / “(no response)” bubble.
        this.orch.deleteMessage(placeholder.id);
      }
      return reply;
    } catch (err) {
      if (recording) this.orch.deps.recorder.discard(this.agent.id);
      throw err;
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
    // Scope skills PER AGENT: keep the full discovery pool so selected names
    // resolve, but disable every discovered skill this agent was not given, so
    // an agent only follows the skills the user attached (opt-in; empty => none).
    const disabledSkills = scopedDisabledSkills(skills, this.agent.skills);
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
      disabledSkills,
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

  /**
   * Tear down every live session so the next `ask()` builds a fresh one. Used by
   * the Lead to recover an agent whose session is stuck/unrecoverable.
   */
  async restart(): Promise<void> {
    const old = [...this.sessions.values()];
    this.sessions.clear();
    this.mailbox = Promise.resolve();
    this.currentWorkItemId = null;
    for (const s of old) await s.dispose().catch(() => undefined);
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
  /** Per-task isolated clone (branch + path), forked off the epic clone. */
  private readonly taskWorktrees = new Map<string, { branch: string; path: string }>();
  /** Max child tasks of one epic allowed to run concurrently (independent streams). */
  private readonly epicConcurrency = Math.max(1, Number(process.env.ATEAM_EPIC_CONCURRENCY ?? 3));
  /** Serializes integrations into each epic clone (merges must never overlap). */
  private readonly epicIntegrateChain = new Map<string, Promise<unknown>>();
  /** Per-task integration-conflict counter, so a persistent conflict escalates. */
  private readonly taskConflicts = new Map<string, number>();
  /** Live parallelism telemetry per epic (peak concurrency + conflicts), flushed
   *  to epic_metrics when the epic merges. */
  private readonly epicMetrics = new Map<string, { maxConcurrent: number; conflicts: number }>();
  /** PR/review state per epic for the iterate-to-quality loop. */
  private readonly epicPr = new Map<string, string>();
  private readonly epicReviewIter = new Map<string, number>();
  /** Per-epic cumulative review-fix tasks created across all rounds (F1b budget). */
  private readonly epicReviewFixTotal = new Map<string, number>();
  /**
   * Per-epic remediation-round budget SHARED across the integrated-build and
   * acceptance gates. One counter (not two) so a churning epic can't burn
   * 2x the rounds by alternating build-fix and acceptance-fix before escalating.
   */
  private readonly epicRemediationIter = new Map<string, number>();
  private readonly epicReviewing = new Set<string>();
  /** In-flight background reviews, awaited on dispose so nothing touches a closed DB. */
  private readonly pendingReviews = new Set<Promise<unknown>>();
  /** Per-message accumulated streamed text, so deltas survive a re-sync. */
  private readonly streamBuffers = new Map<string, string>();
  private static readonly MAX_REVIEW_ITER = 3;
  /** Shared cap for integrated-build + acceptance remediation rounds per epic. */
  private static readonly MAX_REMEDIATION_ITER = 3;
  /** Per-epic review-round budget (I8): configurable so ops can tighten/loosen it. */
  private get maxReviewIter(): number {
    const v = Number(process.env.ATEAM_MAX_REVIEW_ITER);
    return Number.isFinite(v) && v > 0 ? v : ProjectOrchestrator.MAX_REVIEW_ITER;
  }
  /** Cumulative review-fix budget per epic before forcing a converge-or-escalate (F1b). */
  private static readonly MAX_REVIEW_FIXES = 12;
  private get maxReviewFixes(): number {
    const v = Number(process.env.ATEAM_MAX_REVIEW_FIXES);
    return Number.isFinite(v) && v > 0 ? v : ProjectOrchestrator.MAX_REVIEW_FIXES;
  }

  /** Work items with an in-flight runWorkItem, so the manager never double-starts one. */
  private readonly running = new Set<string>();
  /** Work items parked awaiting a human/Lead decision, so the manager won't re-drive them. */
  private readonly awaitingInput = new Set<string>();
  /** Work items the Team Lead has already tried to unblock (one-shot, so assist can't loop). */
  private readonly leadAssisted = new Set<string>();
  /** No-code-blocked work items → the pending Question id, so an @mention take-over is
   *  scoped to no-code blockers ONLY and never touches build/integration/epic-review questions. */
  private readonly noCodeQuestions = new Map<string, string>();
  /** Epics the user discarded — guards in-flight turns from resurrecting them. */
  private readonly discardedEpics = new Set<string>();
  /** Epics the user chose to merge despite unmet acceptance criteria. */
  private readonly forcedAccept = new Set<string>();

  /** Team Lead proactive manager loop. */
  private readonly leadTickMs = Number(process.env.ATEAM_LEAD_TICK_MS ?? 15000);
  private leadStarted = false;
  private disposed = false;
  private leadPoke?: Cancel;
  /** agentId -> last time the Lead nudged them, so guidance stays low-noise. */
  private readonly leadNudges = new Map<string, number>();
  /**
   * agentId -> consecutive unrecoverable trouble signals (empty builds, turn
   * errors, ignored nudges). At RESTART_THRESHOLD the Lead restarts the session.
   */
  private readonly agentTrouble = new Map<string, number>();
  private static readonly RESTART_THRESHOLD = 2;
  /** agentIds whose session the Lead has already restarted once (avoid loops). */
  private readonly restartedOnce = new Set<string>();
  /** Per-WORK-ITEM one-restart-then-escalate budget for the per-task gates. Kept
   *  separate from the agent-scoped `restartedOnce` (used by supervision) so a
   *  restart on task A never prematurely escalates task B for the same agent. */
  private readonly restartedForItem = new Set<string>();
  /** Throttle + dedupe the Lead's status heartbeat posted to main chat. */
  private readonly statusHeartbeatMs = Number(process.env.ATEAM_STATUS_HEARTBEAT_MS ?? 90000);
  private lastStatusAt = 0;
  private lastStatusSig = '';
  /**
   * Board-activity watchdog: the epoch-ms the board last moved (a status change,
   * assignment, or run start). Lets the manager distinguish "legitimately waiting"
   * from "stalled" so it can proactively re-drive / escalate instead of going quiet.
   */
  private lastBoardActivityAt = Date.now();
  private lastStallSig = '';
  private readonly stallMs = Number(process.env.ATEAM_STALL_MS ?? 120000);
  /** workItemId -> epoch-ms it entered `running`, for the stall watchdog. */
  private readonly runningSince = new Map<string, number>();
  /** How long a `running` guard may persist with an idle agent before it's deemed leaked. */
  private readonly runWatchdogMs = Number(process.env.ATEAM_RUN_WATCHDOG_MS ?? 300000);
  /** reviewerAgentId -> the PR they are actively reviewing (for add_review_comment). */
  private readonly reviewContext = new Map<string, { epicId: string; prId: string }>();
  /** Cached brownfield signal (repo already has substantial source). */
  private brownfieldCache: boolean | undefined;

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

  /**
   * Start a fresh user↔Lead conversation (a `dm` thread) so the user can kick off
   * a new epic without piling onto the single main channel. Auto-titled from the
   * first message the user sends (see `chat`).
   */
  createLeadThread(topic?: string, workItemId?: string): Thread {
    // A conversation can be filed under an existing epic (organizational grouping
    // in the Threads rail); otherwise it's a general user↔Lead side channel.
    const linkedEpic =
      workItemId && this.deps.store.getWorkItem(workItemId)?.kind === 'epic' ? workItemId : null;
    const thread = this.deps.store.createThread({
      projectId: this.projectId,
      kind: 'dm',
      topic: topic?.trim() || 'New conversation',
      workItemId: linkedEpic,
      participantAgentIds: [this.lead().id],
      includesUser: true,
    });
    this.deps.bus.publish({ type: 'thread.updated', projectId: this.projectId, thread });
    return thread;
  }

  private readonly epicThreadCache = new Map<string, string>();

  /**
   * The dedicated discussion thread for an epic, created on demand. All of an
   * epic's planning and delivery chatter routes here so the Threads rail can
   * group conversations per epic instead of dumping everything into main.
   */
  private ensureEpicThread(epic: WorkItem): Thread {
    const cachedId = this.epicThreadCache.get(epic.id);
    if (cachedId) {
      const t = this.deps.store.getThread(cachedId);
      if (t) return t;
    }
    const existing = this.deps.store
      .listThreads(this.projectId)
      .find((t) => t.kind === 'group' && t.workItemId === epic.id);
    if (existing) {
      this.epicThreadCache.set(epic.id, existing.id);
      return existing;
    }
    const thread = this.deps.store.createThread({
      projectId: this.projectId,
      kind: 'group',
      topic: 'Team discussion',
      workItemId: epic.id,
      participantAgentIds: [this.lead().id],
      includesUser: true,
    });
    this.epicThreadCache.set(epic.id, thread.id);
    this.deps.bus.publish({ type: 'thread.updated', projectId: this.projectId, thread });
    return thread;
  }

  /**
   * Which conversation a work item's discussion belongs to: its epic's dedicated
   * thread when the item is an epic or an epic child, otherwise the main channel
   * (standalone tasks and direct user↔Lead talk stay in main).
   */
  private threadForWorkItem(item: WorkItem): Thread {
    const epicId = item.kind === 'epic' ? item.id : item.parentId;
    if (epicId) {
      const epic = this.deps.store.getWorkItem(epicId);
      if (epic && epic.kind === 'epic') return this.ensureEpicThread(epic);
    }
    return this.ensureMainThread();
  }

  /* -------------------------------------------------------------- events */

  onSessionEvent(agent: Agent, e: SessionEvent, workItemId: string | null): void {
    const { bus } = this.deps;
    const pid = this.projectId;
    if (this.recordingActive) {
      if (e.kind === 'reasoning') {
        this.deps.recorder.event(agent.id, {
          at: new Date().toISOString(),
          kind: 'reasoning',
          label: e.text,
        });
      } else if (e.kind === 'tool_call') {
        this.deps.recorder.event(agent.id, {
          at: new Date().toISOString(),
          kind: 'tool_call',
          label: e.toolName,
          detail: e.detail ?? null,
        });
      } else if (e.kind === 'tool_result') {
        this.deps.recorder.event(agent.id, {
          at: new Date().toISOString(),
          kind: 'tool_result',
          label: e.toolName,
          detail: e.detail ?? null,
        });
      } else if (e.kind === 'usage') {
        this.deps.recorder.event(agent.id, {
          at: new Date().toISOString(),
          kind: 'usage',
          label: e.model || 'model',
          detail: {
            inputTokens: e.inputTokens,
            outputTokens: e.outputTokens,
            durationMs: e.durationMs,
          },
        });
      }
    }
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
      case 'usage':
        this.recordUsage(agent.id, workItemId, {
          inputTokens: e.inputTokens,
          outputTokens: e.outputTokens,
        });
        break;
    }
  }

  /** Accumulate + broadcast time/token usage for an agent on a work item. */
  recordUsage(
    agentId: string,
    workItemId: string | null,
    delta: { inputTokens?: number; outputTokens?: number; timeMs?: number; turns?: number },
  ): void {
    if (!delta.inputTokens && !delta.outputTokens && !delta.timeMs && !delta.turns) return;
    const entry = this.deps.store.recordUsage({
      projectId: this.projectId,
      workItemId,
      agentId,
      ...delta,
    });
    this.deps.bus.publish({ type: 'usage.updated', projectId: this.projectId, entry });
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

  chat(content: string, threadId?: string): Promise<void> {
    // Route to the requested conversation when it's a valid user-facing thread
    // (the main channel or a user↔Lead `dm`); otherwise fall back to main.
    const requested = threadId ? this.deps.store.getThread(threadId) : undefined;
    const target =
      requested &&
      requested.projectId === this.projectId &&
      (requested.kind === 'main' || requested.kind === 'dm')
        ? requested
        : this.ensureMainThread();

    // A brand-new conversation takes its title from the user's first message.
    if (target.kind === 'dm' && target.topic === 'New conversation') {
      const title = content.trim().replace(/\s+/g, ' ').slice(0, 60);
      const renamed = this.deps.store.renameThread(target.id, title || 'New conversation');
      if (renamed)
        this.deps.bus.publish({
          type: 'thread.updated',
          projectId: this.projectId,
          thread: renamed,
        });
    }

    const userMsg = this.deps.store.appendChat({
      projectId: this.projectId,
      threadId: target.id,
      role: 'user',
      authorAgentId: null,
      content,
    });
    this.deps.bus.publish({ type: 'chat.message', projectId: this.projectId, message: userMsg });

    return (async () => {
      const lead = this.lead();
      // Did the user summon the Team Lead directly (@lead / @team-lead / @<name>)?
      // If so, the Lead is "woken to act": beyond replying it takes over any parked
      // no-code blockers. Intent is classified on the message with the mention
      // token stripped, so "@lead" alone doesn't falsely trip build/discuss routing.
      const leadMentioned = mentionsAgent(content, lead.displayName);
      const intentText = leadMentioned ? stripMention(content, lead.displayName) : content;
      const roster = this.specialists()
        .map((s) => `- \`${s.name}\` (${s.displayName}): ${s.description}`)
        .join('\n');
      const history = this.recentHistory(target.id);
      const prompt =
        `The user says:\n"""\n${content}\n"""\n\n` +
        `Team available:\n${roster || '(no specialists yet)'}\n\n` +
        `Conversation so far:\n${history}\n\n` +
        `Respond to the user. If this needs hands-on work, say briefly how you'll approach it as an epic. ` +
        `If it would benefit from a team discussion, note that you'll convene one.`;
      // Fire the Lead's conversational acknowledgement, but NEVER gate dispatch on
      // it. The board is materialized in code (planEpic → decomposeEpic), so a chat
      // reply that rat-holes — e.g. looping on a stray built-in tool — must not block
      // or skip the real decomposition. The mailbox still serializes the Lead's
      // turns, and the reply streams to the user over WS as it lands.
      void this.actor(lead)
        .ask(prompt, target.id, null)
        .catch(() => undefined);

      // Route the request. A build/change request becomes an epic the Lead decomposes;
      // a pure discussion request convenes a brainstorm. While paused the Lead still
      // replies above, but starts no new team work until the user resumes.
      const buildIntent =
        /\b(build|implement|create|add|develop|feature|fix|refactor|integrate|migrate|support)\b/i.test(
          intentText,
        );
      const discussIntent = /\b(brainstorm|discuss|approach|architect|explore|options)\b/i.test(
        intentText,
      );
      if (this.paused) {
        // no-op: user is redirecting; hold off on kicking off work
      } else if (buildIntent) {
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

      // A direct @mention makes the Lead address the user's issue immediately: it
      // takes over parked no-code blockers so the human prompt clears and work
      // resumes under the Lead's guidance.
      if (leadMentioned) await this.leadTakeOverPending();
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
    this.emitEvent(lead.id, 'system', `Opened epic "${epic.title}"`, null, epic.id);
    this.notify(
      'epic',
      `New epic: ${epic.title}`,
      'The Team Lead opened an epic and is planning the work.',
      'board',
      epic.id,
      lead.id,
    );

    await this.decomposeEpic(epic, content);
    return epic;
  }

  /**
   * Escape hatch: abort a runaway epic. Deletes its board items, stops its
   * agents, throws away its isolated clone, and - if the epic was already merged
   * - reverts the merge from the real repo. Otherwise the user's repo is
   * untouched (all epic work lives in a throwaway clone until merge).
   */
  async discardEpic(
    epicId: string,
    opts: { revert?: boolean } = {},
  ): Promise<{
    deletedTasks: number;
    removedWorktree: boolean;
    merged: boolean;
    reverted: boolean;
    detail: string;
  }> {
    const epic = this.deps.store.getWorkItem(epicId);
    if (!epic || epic.kind !== 'epic' || epic.projectId !== this.projectId) {
      throw new Error('Epic not found');
    }
    const lead = this.lead();
    const repoDir = this.project().repoDir;
    const children = this.deps.store.listChildTasks(epicId);

    // 1. Fence the epic so any in-flight turn bails instead of resurrecting it.
    this.discardedEpics.add(epicId);
    for (const c of children) {
      this.running.delete(c.id);
      this.runningSince.delete(c.id);
      this.awaitingInput.delete(c.id);
      this.armed.delete(c.id);
    }
    this.running.delete(epicId);
    this.awaitingInput.delete(epicId);

    // 2. Reset the agents that were working this epic, and clear any parked
    //    questions they raised so nothing stays stuck on `needs_input`.
    const involved = new Set<string>([lead.id]);
    for (const c of children) if (c.assigneeAgentId) involved.add(c.assigneeAgentId);
    for (const [agentId, rc] of this.reviewContext) {
      if (rc.epicId === epicId) {
        involved.add(agentId);
        this.reviewContext.delete(agentId);
      }
    }
    for (const agentId of involved) this.setStatus(agentId, 'idle');
    for (const q of this.deps.store.listQuestions(this.projectId)) {
      if (q.status === 'pending' && q.agentId && involved.has(q.agentId)) {
        this.answer(q.id, '(epic discarded)');
      }
    }

    // 3. Git: revert a merged epic (if asked), then throw away the isolated clone
    //    + leftover branch. Nothing merged => the real repo is already pristine.
    const merged =
      epic.status === 'done' ||
      this.deps.store
        .listPRs(this.projectId)
        .some((pr) => pr.workItemId === epicId && pr.status === 'merged');
    let reverted = false;
    let detail = '';
    if (merged && opts.revert && epic.branch) {
      try {
        const commit = await this.deps.git.findEpicMergeCommit(repoDir, epic.branch);
        if (commit) {
          const r = await this.deps.git.revertMerge(repoDir, commit);
          reverted = r.ok;
          detail = r.detail;
          this.emitEvent(
            lead.id,
            'git',
            r.ok ? `Reverted epic merge: ${r.detail}` : `Revert failed: ${r.detail}`,
            null,
            epicId,
          );
        } else {
          detail = 'merge commit not found; nothing reverted';
        }
      } catch (err) {
        detail = err instanceof Error ? err.message : String(err);
      }
    }
    const wt = this.epicWorktrees.get(epicId);
    let removedWorktree = false;
    try {
      if (wt) {
        await this.deps.git.removeWorktree(repoDir, wt.path);
        removedWorktree = true;
      }
      await this.deps.git.deleteBranch(repoDir, epic.branch ?? '');
    } catch {
      /* best-effort cleanup */
    }
    this.deps.git.removeEpicTaskWorktrees(this.projectId, epicId);
    for (const child of children) this.taskWorktrees.delete(child.id);
    this.epicWorktrees.delete(epicId);
    this.epicPr.delete(epicId);
    this.epicReviewIter.delete(epicId);
    this.epicReviewFixTotal.delete(epicId);
    this.epicRemediationIter.delete(epicId);
    this.epicMetrics.delete(epicId);
    this.epicIntegrateChain.delete(epicId);
    this.epicReviewing.delete(epicId);

    // 4. Delete board rows: PRs, threads, child tasks, then the epic itself.
    for (const pr of this.deps.store.listPRs(this.projectId)) {
      if (pr.workItemId === epicId) this.deps.store.deletePR(pr.id);
    }
    for (const t of this.deps.store.listThreads(this.projectId)) {
      if (t.workItemId === epicId) {
        this.deps.store.deleteThread(t.id);
        this.deps.bus.publish({
          type: 'thread.updated',
          projectId: this.projectId,
          thread: { ...t, status: 'closed' },
        });
      }
    }
    for (const c of children) {
      this.deps.store.deleteWorkItem(c.id);
      this.deps.bus.publish({
        type: 'workitem.deleted',
        projectId: this.projectId,
        workItemId: c.id,
      });
    }
    this.deps.store.deleteEpicDesign(epicId);
    this.deps.store.deleteCriteria(epicId);
    this.deps.store.deleteWorkItem(epicId);
    this.deps.bus.publish({
      type: 'workitem.deleted',
      projectId: this.projectId,
      workItemId: epicId,
    });

    // 5. Report to the user.
    const summary =
      `🧹 Discarded epic "${epic.title}".\n\n` +
      `Removed ${children.length} task(s) and stopped the team.` +
      (merged
        ? reverted
          ? ' Reverted the merged changes from the repo.'
          : opts.revert
            ? ` Could not revert automatically (${detail}).`
            : ' The already-merged changes were left in place.'
        : ' Nothing was merged, so your repo is unchanged.');
    this.postMessage(this.ensureMainThread().id, lead, summary);
    this.notify('system', `Epic discarded: ${epic.title}`, summary, 'board', null, lead.id);
    this.emitEvent(lead.id, 'system', `Discarded epic "${epic.title}"`, { merged, reverted }, null);
    this.discardedEpics.delete(epicId);

    return { deletedTasks: children.length, removedWorktree, merged, reverted, detail };
  }

  /**
   * Plan + decompose an already-open epic: isolate its worktree, consult PM +
   * Architect, then create stream-tagged task cards for the specialists. Shared by
   * chat-originated epics (planEpic) and board-created epics (onEpicCreated).
   */
  /**
   * True when the project's repo already contains substantial source code (an
   * existing/"brownfield" codebase) rather than an empty greenfield scaffold.
   * Cached per orchestrator. Used to steer decomposition toward one concrete,
   * tested change instead of a per-stream fan-out.
   */
  private async isBrownfieldRepo(): Promise<boolean> {
    if (this.brownfieldCache !== undefined) return this.brownfieldCache;
    let result = false;
    try {
      const files = await this.deps.git.listTrackedFiles(this.project().repoDir);
      const codeExt =
        /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|c|h|cc|cpp|hpp|cs|swift|kt|scala|vue|svelte)$/i;
      const code = files.filter((f) => codeExt.test(f) && !f.includes('node_modules/'));
      result = code.length >= 8;
    } catch {
      result = false;
    }
    this.brownfieldCache = result;
    return result;
  }

  private async decomposeEpic(epic: WorkItem, content: string): Promise<void> {
    const lead = this.lead();
    const thread = this.ensureEpicThread(epic);
    const specs = this.specialists();

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

    // NOTE: we DISPATCH the stream tasks first (step 4 below), THEN consult
    // PM / Architect / Lead as best-effort annotations (step 5b). Those are LLM
    // turns that can ask the user a question and block indefinitely; gating
    // delegation behind them once stranded an epic with zero assigned tasks while
    // the Lead tried to build everything itself. Dispatch must never depend on a
    // planning turn completing.

    // 4. Decompose into stream-tagged task cards. Core builders run in parallel;
    //    docs/devops wait on the core build; verifiers (QA/review/security) wait on
    //    everything. Decomposition is IDEMPOTENT: if the Lead/PM/Architect already
    //    created a task for a stream during planning, we reuse it instead of adding
    //    a duplicate wave.
    const verifiers = specs.filter((s) => /^(qa|reviewer|security)$/.test(s.name));
    const allBuilders = specs.filter(
      (s) => s.name !== 'pm' && s.name !== 'architect' && !verifiers.includes(s),
    );
    // Scope the builder set DOWN to what the request actually needs. This drops
    // read-only roles (researcher) that can't deliver code, and UI streams
    // (ux/frontend) for headless/API/library requests. Pure + deterministic so it
    // never blocks dispatch; conservative so it never strands a needed discipline.
    const scope = scopeStreams(
      content,
      allBuilders.map((s) => s.name),
    );
    for (const d of scope.drops) {
      this.emitEvent(lead.id, 'system', `Scoped out [${d.stream}]: ${d.reason}`, null, epic.id);
    }
    const keptBuilders = allBuilders.filter((s) => scope.keep.includes(s.name));
    // docs/devops depend on the code the other builders produce.
    const postStreams = new Set(['docs', 'devops']);
    const coreBuilders = keptBuilders.filter((s) => !postStreams.has(s.name));
    const postBuilders = keptBuilders.filter((s) => postStreams.has(s.name));
    const goal = shortGoal(content);

    // Tasks already on the board for this epic (e.g. created by the Lead/PM/
    // Architect via create_work_item during planning), indexed by stream.
    const existingByStream = new Map<string, string>();
    for (const c of this.deps.store.listChildTasks(epic.id)) {
      if (c.stream && !existingByStream.has(c.stream)) existingByStream.set(c.stream, c.id);
    }

    const makeTask = (
      s: Agent,
      opts: { verify?: boolean; dependsOn?: string[]; concrete?: boolean },
    ): string => {
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
          ? `Part of epic "${epic.title}".\n\nAcceptance criteria: ${s.displayName} sign-off - ` +
            `verify the build tasks meet the quality bar before the epic is done.\n\n` +
            `ROLE BOUNDARY: you VERIFY and REPORT. Do NOT modify production source files. ` +
            `You may add/adjust ONLY test or documentation files. If you find a defect, hand it ` +
            `back as a specific finding (what's wrong, where, and the fix) for the responsible ` +
            `builder to correct - do not silently fix production code yourself.`
          : opts.concrete
            ? `Part of epic "${epic.title}".\n\nThis is an EXISTING codebase. First STUDY the ` +
              `relevant code, structure, and conventions. Then make ONE small, well-scoped, ` +
              `concrete improvement a maintainer would accept - implement it as REAL source ` +
              `changes WITH tests in the repo's existing style. Do NOT just write documentation ` +
              `or analysis; a docs-only change does not satisfy this task. Cite the files you ` +
              `changed and the test command you ran.`
            : `Part of epic "${epic.title}".\n\nAcceptance criteria: deliver the ${s.displayName} ` +
              `slice of "${goal}" to a principal-engineer standard - correct, tested, and matching ` +
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

    // Existing codebase: converge on ONE concrete, tested change assigned to a
    // single primary builder, instead of fanning out a task per stream (which
    // tends to make each stream write its own analysis doc and land no code).
    // Greenfield keeps the parallel per-stream fan-out.
    const brownfield = await this.isBrownfieldRepo();
    let builderTaskIds: string[];
    let builders: Agent[];
    if (brownfield && coreBuilders.length) {
      // C1: single owner for single-layer work (preserves brownfield convergence),
      // but fan out per code layer when the request clearly spans multiple layers so
      // cross-layer bugs each get a real owner (not silently fixed during "verify").
      const pick = pickBrownfieldBuilders(content, coreBuilders.map((s) => s.name));
      const chosen = pick.primaries
        .map((n) => coreBuilders.find((s) => s.name === n))
        .filter((s): s is Agent => !!s);
      builders = chosen.length ? chosen : [coreBuilders[0]!];
      builderTaskIds = builders.map((s) => makeTask(s, { concrete: true }));
      if (pick.multiLayer)
        this.emitEvent(
          lead.id,
          'system',
          `Cross-layer scope — fanned out to ${builders.map((b) => b.name).join(', ')}`,
          null,
          epic.id,
        );
    } else {
      const coreTaskIds = coreBuilders.map((s) => makeTask(s, {}));
      const postTaskIds = postBuilders.map((s) => makeTask(s, { dependsOn: coreTaskIds }));
      builderTaskIds = [...coreTaskIds, ...postTaskIds];
      builders = keptBuilders;
    }
    for (const v of verifiers) makeTask(v, { verify: true, dependsOn: builderTaskIds });

    // DESIGN-FIRST (AC1/AC2/AC3/AC5): the deterministic template board above is the
    // synchronous FLOOR - it is already created and dispatched, so the board is
    // never stranded (scar-tissue invariant preserved). For NON-TRIVIAL epics we
    // now run a front-loaded, time-boxed Architect (or Lead) design turn that
    // ENRICHES those tasks with per-stream acceptance; builders read it via the
    // existing awaitEpicDesign wait. Trivial/simple epics skip the design turn.
    const architectForDesign = specs.find((s) => s.name === 'architect');
    const complexity: Complexity = classifyComplexity({
      request: content,
      keptCoreStreams: coreBuilders.map((s) => s.name),
      multiLayer: pickBrownfieldBuilders(
        content,
        coreBuilders.map((s) => s.name),
      ).multiLayer,
      brownfield,
      constraintCount: detectConstraints([content]).length,
    });
    if (complexity === 'standard') {
      const streamToTaskId = new Map(existingByStream);
      await this.designThenEnrich(epic, content, thread, streamToTaskId, architectForDesign, brownfield);
    } else {
      this.emitEvent(
        lead.id,
        'system',
        `Trivial change - splitting directly without a design step`,
        null,
        epic.id,
      );
    }

    // 5. Post a clear, user-facing plan summary in the main chat so the user knows
    //    exactly what was decided and what happens next.
    const streamList = builders.map((b) => b.name).join(', ') || 'the team';
    const verifyNote = verifiers.length
      ? `${verifiers.map((v) => v.displayName).join(', ')} will verify against the quality bar, then I raise a PR and merge. `
      : 'I raise a PR and merge once the work meets the quality bar. ';
    const summary =
      `📋 Plan for "${epic.title}"\n\n` +
      `${goal}.\n\n` +
      `I've broken this into ${builderTaskIds.length} build task(s) across ${streamList} - ` +
      `assigned and starting now in parallel. ${verifyNote}` +
      `Follow progress on the Board; I'll keep you posted here.`;
    this.postMessage(thread.id, lead, summary);
    this.notify(
      'plan',
      `Plan ready: ${epic.title}`,
      `${builderTaskIds.length} task(s) across ${streamList} - work is starting.`,
      'chat',
      epic.id,
      lead.id,
    );

    // 5b. Best-effort planning annotations, AFTER the work is already assigned and
    //     running. They enrich the epic thread with acceptance criteria and a
    //     design, but can NEVER block or prevent delegation: each is guarded so a
    //     slow turn, an error, or a parked question leaves the build unaffected.
    const pm = specs.find((s) => s.name === 'pm');
    if (pm) {
      try {
        const pmText = await this.actor(pm).ask(
          `Product check for epic "${epic.title}" - the build is already underway.\n` +
            `Request: ${content}\n` +
            `State the user outcome in one sentence, then list the acceptance criteria. ` +
            `Format EVERY acceptance criterion on its OWN line, one criterion per line, each ` +
            `prefixed with "AC:" and written in Given/When/Then form where possible. ` +
            `CRITICALLY: turn every HARD CONSTRAINT in the request into its own explicit, ` +
            `checkable criterion - storage model (e.g. in-memory, not persisted), dependency ` +
            `policy (e.g. no external dependencies), language/runtime, and each required ` +
            `endpoint/interface. ` +
            `Do not ask the user questions here and do not write code.`,
          thread.id,
          epic.id,
        );
        // Persist the criteria as structured records (not just a chat post) so
        // later gates can map each to a test and block merge until all are met.
        const texts = parseCriteria(pmText ?? '');
        if (texts.length) {
          const criteria = this.deps.store.replaceCriteria({
            projectId: this.projectId,
            epicId: epic.id,
            texts,
          });
          this.deps.bus.publish({
            type: 'criteria.updated',
            projectId: this.projectId,
            epicId: epic.id,
            criteria,
          });
          this.emitEvent(
            pm.id,
            'system',
            `Recorded ${texts.length} acceptance criteria for "${epic.title}"`,
            null,
            epic.id,
          );
        }
      } catch {
        /* annotation is best-effort */
      }
    }
    // NOTE: the Architect design turn is no longer run here as an after-the-fact
    // annotation. It now runs FRONT-LOADED in `designThenEnrich` (called above,
    // before the builders act) for non-trivial epics, so the design drives the
    // tasks instead of trailing the build.
    // MAJOR-1: author a spec-derived acceptance probe into the epic clone so the
    // deterministic epic gate can check the delivered CONTRACT independently of the
    // builders' own unit tests. Best-effort, never blocks dispatch.
    await this.authorAcceptanceProbe(epic, content, thread);
    try {
      await this.actor(lead).ask(
        `The tasks for epic "${epic.title}" are already created, assigned, and running - one per ` +
          `stream. Post a brief framing note for the team: the goal, how the streams fit ` +
          `together, dependencies, and the quality bar. Do NOT create tasks, do NOT implement ` +
          `anything yourself, and do NOT ask the user questions here - just coordinate.`,
        thread.id,
        epic.id,
      );
    } catch {
      /* annotation is best-effort */
    }
  }

  /* ------------------------------------------------------- group chats */

  /** Lead-moderated group discussion: each participant contributes in parallel. */
  /**
   * Front-loaded, time-boxed design turn for a non-trivial epic (AC1/AC3/AC5). The
   * Architect - or the Lead when no architect is on the team - produces a short
   * technical design plus a per-stream task breakdown; the design is persisted for
   * the builders' `awaitEpicDesign` wait, and each breakdown line ENRICHES the
   * matching template task with concrete acceptance. Bounded by
   * `ATEAM_DESIGN_TIMEOUT_MS`; on timeout/error/empty it is a no-op and the tasks
   * keep their template descriptions, so the board is never stranded.
   */
  private async designThenEnrich(
    epic: WorkItem,
    content: string,
    thread: Thread,
    streamToTaskId: Map<string, string>,
    architect: Agent | undefined,
    brownfield: boolean,
  ): Promise<void> {
    const streams = [...streamToTaskId.keys()];
    if (!streams.length) return;
    const designer = architect ?? this.lead();
    const role = architect ? 'Software Architect' : 'Team Lead';
    const stackClause = brownfield
      ? `This is an EXISTING codebase. Honor its AGENTS.md / CLAUDE.md / CONTRIBUTING / README and ` +
        `current conventions; design WITHIN the established stack - do not propose a new one.`
      : `This is a GREENFIELD repo with no established stack. DECIDE and state the tech stack, ` +
        `frameworks, language, and project layout the team will use.`;
    const prompt =
      `You are the ${role}. Design epic "${epic.title}" BEFORE the team builds it.\n` +
      `Request: ${content}\n\n` +
      `${stackClause}\n\n` +
      `First give a 3-6 sentence technical design: the approach, key decisions, and the SHARED ` +
      `interfaces/contracts between streams (API shapes, data models, shared types).\n` +
      `Then output a per-stream task breakdown as ONE LINE PER STREAM in EXACTLY this format:\n` +
      `[stream] <task title> :: <concrete acceptance criteria>\n` +
      `Use only these streams: ${streams.join(', ')}. Do not invent streams, do not create tasks ` +
      `yourself, do not ask the user questions, and do not write code.`;
    let raw: string | typeof TIMED_OUT;
    try {
      raw = await withTimeout(
        this.actor(designer).ask(prompt, thread.id, epic.id),
        Number(process.env.ATEAM_DESIGN_TIMEOUT_MS ?? 45_000),
      );
    } catch {
      return; // never crash decomposition - tasks keep their template descriptions
    }
    if (raw === TIMED_OUT) {
      this.emitEvent(
        designer.id,
        'system',
        `Design step timed out - proceeding with template tasks`,
        null,
        epic.id,
      );
      return;
    }
    const text = (raw ?? '').trim();
    if (!text) return;
    this.deps.store.setEpicDesign({
      projectId: this.projectId,
      epicId: epic.id,
      content: text.slice(0, 6000),
    });
    const tasks = parseDesignBreakdown(text, streams);
    let enriched = 0;
    for (const t of tasks) {
      const taskId = streamToTaskId.get(t.stream);
      if (!taskId) continue;
      const item = this.deps.store.getWorkItem(taskId);
      if (!item) continue;
      // Enrichment is append-only. Skip a task that is already reviewed/done, and
      // skip one already enriched so a re-drive/resume never double-appends (M4).
      if (item.status === 'review' || item.status === 'done') continue;
      if ((item.description ?? '').includes('<!--design-acceptance-->')) continue;
      const patched =
        `${item.description ?? ''}\n\n<!--design-acceptance-->\nDesign acceptance (${t.stream}): ${t.acceptance}`.slice(
          0,
          8000,
        );
      const updated = this.deps.store.updateWorkItem(taskId, { description: patched });
      if (updated) {
        this.deps.bus.publish({
          type: 'workitem.updated',
          projectId: this.projectId,
          workItem: updated,
        });
        enriched += 1;
      }
    }
    this.emitEvent(
      designer.id,
      'system',
      `${role} designed "${epic.title}" - enriched ${enriched} task(s) with design acceptance`,
      { streams: tasks.map((t) => t.stream) },
      epic.id,
    );
  }

  async runGroupChat(
    topic: string,
    participantIds: string[],
    workItemId: string | null,
    opts: { decider?: 'lead' | 'pm'; rounds?: number; includesUser?: boolean } = {},
  ): Promise<string> {
if (this.groupDepth >= 2) return ''; // guard against runaway nesting
    this.groupDepth += 1;
    try {
      const lead = this.lead();
      const participants = participantIds
        .map((id) => this.deps.store.getAgent(id))
        .filter((a): a is Agent => !!a && a.kind === 'specialist');
      // Bounded rounds so an agent-initiated discussion always terminates.
      const rounds = Math.max(
        1,
        Math.min(opts.rounds ?? Number(process.env.ATEAM_DISCUSSION_ROUNDS ?? 2), 4),
      );
      const includesUser = opts.includesUser ?? true;
      // The decider resolves the discussion: the PM for product questions (when on
      // the team), otherwise the Lead.
      const pm = this.specialists().find((s) => s.name === 'pm');
      const decider = opts.decider === 'pm' && pm ? pm : lead;
      const thread = this.deps.store.createThread({
        projectId: this.projectId,
        kind: 'group',
        topic,
        workItemId,
        participantAgentIds: [lead.id, ...participants.map((p) => p.id)],
        includesUser,
      });
      this.deps.bus.publish({ type: 'thread.updated', projectId: this.projectId, thread });

      // Lead opens the discussion.
      await this.actor(lead).ask(
        `You are moderating a group discussion titled "${topic}". Open it by framing the goal and the key questions for the team in 2-3 sentences.`,
        thread.id,
        workItemId,
      );

      // Participants contribute over up to `rounds` bounded rounds; later rounds
      // refine given the discussion so far.
      let contributions: string[] = [];
      for (let r = 1; r <= rounds; r++) {
        contributions = await Promise.all(
          participants.map((p) =>
            this.actor(p).ask(
              `Group discussion "${topic}" (round ${r} of ${rounds}). ` +
                (r > 1
                  ? `Refine or converge given the discussion so far; do not repeat yourself. `
                  : ``) +
                `Give your concrete recommendation from your discipline in 2-4 sentences. Reference specifics.`,
              thread.id,
              workItemId,
            ),
          ),
        );
      }

      // The decider resolves it into a FINAL decision.
      const decision = await this.actor(decider).ask(
        `As the ${decider.displayName}, RESOLVE the discussion "${topic}" into a single clear, final decision and next steps (2-4 sentences). Do not ask the user; make the call.\n\nLatest contributions:\n${contributions
          .map((c, i) => `- ${participants[i]!.displayName}: ${c}`)
          .join('\n')}`,
        thread.id,
        workItemId,
      );

      // Write the decision back onto the work item so it survives and is visible on
      // the board. Uses a DISTINCT marker from the Lead one-shot unblock decision
      // so it never trips `alreadyLeadAssisted`.
      
      if (workItemId) {
        const item = this.deps.store.getWorkItem(workItemId);
        if (item) {
          const patched =
            `${item.description ?? ''}\n\n<!--group-decision-->\nTeam decision (${topic}): ${decision.trim()}`.slice(
              0,
              8000,
            );
          const updated = this.deps.store.updateWorkItem(workItemId, { description: patched });
          if (updated)
            this.deps.bus.publish({
              type: 'workitem.updated',
              projectId: this.projectId,
              workItem: updated,
            });
        }
      }
      this.emitEvent(
        decider.id,
        'discussion',
        `${decider.displayName} resolved group discussion "${topic}"`,
        { decider: decider.name, rounds },
        workItemId,
      );

      // Post a short summary back to the main thread so the user stays informed.
      const main = this.ensureMainThread();
      this.postMessage(main.id, lead, `📋 Discussion "${topic}" concluded. ${decision}`);
      this.deps.store.appendEvent({
        projectId: this.projectId,
        agentId: decider.id,
        type: 'discussion',
        summary: `Group chat: ${topic}`,
      });
      this.deps.bus.publish({
        type: 'thread.updated',
        projectId: this.projectId,
        thread: this.deps.store.closeThread(thread.id) ?? thread,
      });
      return decision;
    } finally {
      this.groupDepth -= 1;
    }
  }

  /** Route a discussion to the right decider: the PM owns product/scope calls. */
  private pickDecider(topic: string): 'lead' | 'pm' {
    const hasPm = this.specialists().some((s) => s.name === 'pm');
    if (
      hasPm &&
      /\b(product|user|ux|scope|priorit|requirement|feature|business|customer|which|should we)\b/i.test(
        topic,
      )
    )
      return 'pm';
    return 'lead';
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
    // Targeted participants: the most relevant disciplines, EXCLUDING the requester.
    // The requester is mid-turn awaiting this discussion, so re-asking it would
    // deadlock its own mailbox; its position is already implied by the topic, and
    // the resolved decision is written back onto its work item.
    const participants = this.pickDiscussants()
      .filter((id) => id !== requester.id)
      .slice(0, 4);
    this.deps.store.appendEvent({
      projectId: this.projectId,
      agentId: requester.id,
      type: 'discussion',
      summary: `${requester.displayName} requested a group chat: ${topic}`,
    });
    // Agent-initiated discussions resolve WITHIN the team (no user prompt); the
    // user still sees the concluding summary.
    await this.runGroupChat(topic, participants, this.resolveDiscussionEpic(requester, workItemId), {
      decider: this.pickDecider(topic),
      includesUser: false,
    });
  }

  /**
   * Which epic an ad-hoc discussion belongs to. Group chats requested during early
   * inspection turns have a null `workItemId`, which used to dump them into the
   * rail's “General” bucket. Recover the epic from, in order: the turn's work item,
   * the requester's active item, or (when unambiguous) the single in-progress epic.
   */
  private resolveDiscussionEpic(requester: Agent, workItemId: string | null): string | null {
    if (workItemId) return workItemId;
    const items = this.deps.store.listWorkItems(this.projectId);
    const mine = items.find(
      (w) =>
        w.assigneeAgentId === requester.id && (w.status === 'in_progress' || w.status === 'todo'),
    );
    if (mine) return mine.id;
    const activeEpics = items.filter((w) => w.kind === 'epic' && w.status === 'in_progress');
    return activeEpics.length === 1 ? activeEpics[0]!.id : null;
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

  /**
   * Pause/resume the team. Paused = no new agent-driven work starts (assignment,
   * pickup, decomposition, group chats); chat with the Lead still works so the
   * user can redirect. Resuming decomposes any epics opened while paused and kicks
   * the manager loop so ready work flows again.
   */
  async setPaused(paused: boolean): Promise<void> {
    const project = this.project();
    if ((project.settings.paused === true) === paused) return;
    const settings = { ...project.settings, paused };
    const updated = this.deps.store.updateProject(this.projectId, { settings });
    if (updated) this.deps.bus.publish({ type: 'project.updated', project: updated });
    this.emitEvent(
      this.lead().id,
      'system',
      paused ? 'Team paused by user' : 'Team resumed',
      null,
      null,
    );
    if (!paused) {
      // Decompose any epics that were opened while paused (no child tasks yet).
      for (const item of this.deps.store.listWorkItems(this.projectId)) {
        if (item.kind !== 'epic' || item.status === 'done') continue;
        if (this.deps.store.listChildTasks(item.id).length > 0) continue;
        await this.decomposeEpic(item, item.description).catch(() => undefined);
      }
      this.pokeLead();
    }
  }

  /**
   * A user opened an epic from the board. Force Lead ownership, then plan +
   * decompose it like a chat-originated epic - unless paused, in which case it
   * waits until the user resumes.
   */
  async onEpicCreated(epicId: string): Promise<void> {
    const epic = this.deps.store.getWorkItem(epicId);
    if (!epic || epic.kind !== 'epic') return;
    const lead = this.lead();
    if (epic.assigneeAgentId !== lead.id) {
      const owned = this.deps.store.updateWorkItem(epicId, { assigneeAgentId: lead.id });
      if (owned)
        this.deps.bus.publish({
          type: 'workitem.updated',
          projectId: this.projectId,
          workItem: owned,
        });
    }
    this.emitEvent(lead.id, 'system', `Opened epic "${epic.title}"`, null, epic.id);
    this.notify(
      'epic',
      `New epic: ${epic.title}`,
      this.paused
        ? 'Epic created while paused - the Team Lead will plan it when you resume.'
        : 'The Team Lead opened an epic and is planning the work.',
      'board',
      epic.id,
      lead.id,
    );
    if (this.paused) return;
    await this.decomposeEpic(this.deps.store.getWorkItem(epicId) ?? epic, epic.description);
  }

  onItemAssigned(workItemId: string): Promise<void> {
    if (this.paused) return Promise.resolve();
    const item = this.deps.store.getWorkItem(workItemId);
    // Work handed to the Team Lead is a delegation request, not something the Lead
    // executes itself (the Lead is read-only and never builds). Route it through
    // the manager loop, which reassigns it to the best-fit specialist.
    if (item && item.kind !== 'epic' && item.assigneeAgentId === this.lead().id) {
      this.pokeLead();
      return Promise.resolve();
    }
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
   * specialist, and keep an eye on the team - nudging blocked agents. Agents
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
    if (this.disposed || this.paused || this.leadPoke) return;
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
    if (this.disposed || this.paused) return;
    this.assignUnassignedWork();
    this.driveAssignedWork();
    this.driveEpicsToClosure();
    this.superviseAgents();
    this.watchForStall();
  }

  /**
   * Self-healing closure driver: keep every open epic's progress honest and, when
   * all of its children have landed (review/done), (re)drive it toward
   * review → merge → done. Epic closure is normally triggered by the
   * task-completion event, but re-checking it on every manager tick means a missed
   * or out-of-order signal can never leave a finished epic stuck open. Both calls
   * are idempotent and guarded, so this is safe to run every tick.
   */
  private driveEpicsToClosure(): void {
    for (const epic of this.deps.store.listWorkItems(this.projectId)) {
      if (epic.kind !== 'epic' || epic.status === 'done') continue;
      if (this.deps.store.listChildTasks(epic.id).length === 0) continue;
      this.sanitizeEpicDependencies(epic.id);
      this.recomputeEpicProgress(epic.id);
      this.maybeFinishEpic(epic.id);
    }
  }

  /**
   * Repair an epic's task dependency graph in place: drop self-references,
   * dependencies on ids that don't exist under this epic, and any edge that
   * closes a cycle. Without this a malformed `dependsOn` (from a future finer
   * decomposition, a manual edit, or a stale id) would stall the epic forever
   * because the blocked task's dependency can never reach review/done. Runs every
   * tick; a no-op when the graph is already clean.
   */
  private sanitizeEpicDependencies(epicId: string): void {
    const tasks = this.deps.store.listChildTasks(epicId);
    if (tasks.length === 0) return;
    const { cleaned, drops } = sanitizeDag(
      tasks.map((t) => ({ id: t.id, dependsOn: t.dependsOn })),
    );
    if (drops.length === 0) return;
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const changed = new Set(drops.map((d) => d.id));
    for (const id of changed) {
      const next = cleaned.get(id) ?? [];
      const updated = this.deps.store.updateWorkItem(id, { dependsOn: next });
      if (updated)
        this.deps.bus.publish({
          type: 'workitem.updated',
          projectId: this.projectId,
          workItem: updated,
        });
    }
    const summary = drops
      .map((d) => `${byId.get(d.id)?.title ?? d.id} (${d.reason})`)
      .slice(0, 6)
      .join(', ');
    this.emitEvent(
      this.lead().id,
      'system',
      `Repaired ${drops.length} invalid dependency edge(s): ${summary}`,
      { drops },
      epicId,
    );
  }

  /**
   * Proactive stall watchdog. When there is open work but nothing is running, no
   * agent is working, and the user isn't being waited on (no pending question),
   * and the board hasn't moved for `stallMs`, the Lead surfaces a concise diagnosis
   * instead of going silent — and escalates to the user only when it genuinely
   * cannot self-heal (e.g. there are no specialists to do the work). Deduped by
   * signature so an unchanged stall stays quiet.
   */
  private watchForStall(): void {
    if (this.disposed || this.paused) return;
    const items = this.deps.store.listWorkItems(this.projectId);
    const openEpics = items.filter((i) => i.kind === 'epic' && i.status !== 'done');
    const openTasks = items.filter(
      (i) => i.kind === 'task' && (i.status === 'todo' || i.status === 'in_progress'),
    );
    if (openEpics.length === 0 && openTasks.length === 0) {
      this.lastStallSig = '';
      return;
    }
    // Actively moving? Only a LIVE turn or a within-watchdog run counts. A `running`
    // guard whose run has exceeded the watchdog (agent idle, no fresh progress) is a
    // suspected leak and must NOT reset the stall clock, or it masks a permanent
    // wedge from the recovery path below.
    if (
      boardHasLiveWork({
        runningIds: [...this.running],
        runningSince: Object.fromEntries(this.runningSince),
        agentStatuses: this.specialists().map((a) => a.status),
        now: Date.now(),
        runWatchdogMs: this.runWatchdogMs,
      })
    ) {
      this.lastBoardActivityAt = Date.now();
      return;
    }
    // Legitimately parked waiting on a human decision is not a stall.
    const awaitingUser = this.deps.store
      .listQuestions(this.projectId)
      .some((q) => q.status === 'pending');
    if (awaitingUser) {
      this.lastBoardActivityAt = Date.now();
      return;
    }
    if (Date.now() - this.lastBoardActivityAt < this.stallMs) return;

    // Provably idle-stalled. Before diagnosing, try to SELF-HEAL: a hung or crashed
    // turn can leave a leaked `running`/`awaitingInput` guard that wedges a task
    // (and, via the per-epic concurrency cap, its siblings) forever. Clearing those
    // stale guards + re-driving is what turns "assigned todo task, all agents idle"
    // from a permanent silent stall into forward progress.
    const plan = planStallRecovery({
      items: items.map((i) => ({
        id: i.id,
        kind: i.kind,
        status: i.status,
        assigneeAgentId: i.assigneeAgentId ?? null,
      })),
      agentStatusById: Object.fromEntries(this.specialists().map((a) => [a.id, a.status])),
      running: [...this.running],
      awaitingInput: [...this.awaitingInput],
      runningSince: Object.fromEntries(this.runningSince),
      now: Date.now(),
      runWatchdogMs: this.runWatchdogMs,
    });
    if (plan.redrive) {
      for (const id of plan.clearRunning) {
        this.running.delete(id);
        this.runningSince.delete(id);
      }
      for (const id of plan.clearAwaiting) this.awaitingInput.delete(id);
      for (const aid of plan.restartAgentIds)
        void this.restartAgentSession(aid, 'stalled/hung turn').catch(() => undefined);
      const freed = plan.clearRunning.length + plan.clearAwaiting.length;
      this.emitEvent(
        this.lead().id,
        'system',
        `Auto-recovered ${freed} stuck task guard(s) after a stall — re-driving work.`,
        { clearRunning: plan.clearRunning, clearAwaiting: plan.clearAwaiting },
        null,
      );
      this.assignUnassignedWork();
      this.driveAssignedWork();
      this.lastBoardActivityAt = Date.now();
      this.lastStallSig = '';
      return;
    }

    // Stalled. Diagnose so the user isn't left guessing whether the team is alive.
    const specs = this.assignableSpecialists();
    const leadId = this.lead().id;
    const unpicked = openTasks.filter((t) => !t.assigneeAgentId || t.assigneeAgentId === leadId);
    let diagnosis: string;
    let stuck = false;
    if (specs.length === 0 && openTasks.length > 0) {
      diagnosis =
        `${openTasks.length} task(s) are ready to build, but there are no specialists on the ` +
        `team to do them. Add specialists from the Agents page and I'll get them moving.`;
      stuck = true;
    } else if (unpicked.length > 0) {
      diagnosis = `${unpicked.length} task(s) haven't been picked up yet — re-driving them now.`;
    } else {
      diagnosis = `${openTasks.length} assigned task(s) aren't progressing — re-kicking them now.`;
    }
    const sig = `${stuck}:${specs.length}:${openTasks.length}:${openEpics.length}`;
    if (sig === this.lastStallSig) return;
    this.lastStallSig = sig;
    this.postMessage(
      this.ensureMainThread().id,
      this.lead(),
      `⚠️ **Unblocking stalled work** — ${diagnosis}`,
    );
    if (stuck) {
      this.notify('system', 'Team is blocked', diagnosis, 'agents', null, leadId);
    }
    // Reset the clock so we re-evaluate after another full stall window.
    this.lastBoardActivityAt = Date.now();
  }

  /** True when the user has paused the team: no new agent-driven work starts. */
  private get paused(): boolean {
    return this.project().settings.paused === true;
  }

  /** Whether this project is currently recording agent sessions to disk. */
  get recordingActive(): boolean {
    return this.project().settings.recordSessions === true;
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
    const leadId = this.lead().id;
    let assigned = 0;
    for (const item of items) {
      if (item.kind === 'epic') continue;
      // Eligible: genuinely unassigned work, OR work the user handed to the Lead
      // for delegation (the Lead routes it but never builds it itself).
      const toLead = item.assigneeAgentId === leadId;
      if (item.assigneeAgentId && !toLead) continue;
      if (item.status !== 'todo' && item.status !== 'backlog') continue;
      const depsMet =
        item.dependsOn.length === 0 ||
        item.dependsOn.every((d) => {
          if (!status.has(d)) return true; // unknown/pruned dep can't block
          const s = status.get(d);
          return s === 'review' || s === 'done';
        });
      if (!depsMet) continue;
      const agent = this.pickAgentForItem(item, specs);
      if (!agent) continue;
      const updated = this.deps.store.updateWorkItem(item.id, { assigneeAgentId: agent.id });
      if (!updated) continue;
      this.lastBoardActivityAt = Date.now();
      this.deps.bus.publish({
        type: 'workitem.updated',
        projectId: this.projectId,
        workItem: updated,
      });
      this.emitEvent(
        this.lead().id,
        'system',
        `${toLead ? 'Delegated' : 'Assigned'} "${item.title}" → ${agent.displayName}`,
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
          if (!statusById.has(d)) return true; // unknown/pruned dep can't block
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
      // Run independent sibling tasks CONCURRENTLY (each in its own isolated task
      // clone), up to a per-epic cap. Dependency ordering is still enforced by the
      // dependsOn DAG above; integration back into the epic clone is serialized
      // separately. Different epics also run in parallel.
      if (item.parentId && this.epicRunning(item.parentId) >= this.epicConcurrency) continue;
      void this.runWorkItem(item.id).catch(() => undefined);
    }
  }

  /**
   * Whether any currently-running work item is a child of `parentId`. Used to
   * serialize sibling tasks that share an epic's single worktree.
   */
  /** How many of an epic's child tasks are running right now. */
  private epicRunning(parentId: string): number {
    let n = 0;
    for (const id of this.running) {
      const it = this.deps.store.getWorkItem(id);
      if (it?.parentId === parentId) n++;
    }
    return n;
  }

  /** Track the peak number of an epic's child tasks running at once. */
  private recordEpicConcurrency(parentId: string): void {
    const cur = this.epicMetrics.get(parentId) ?? { maxConcurrent: 0, conflicts: 0 };
    const running = this.epicRunning(parentId);
    if (running > cur.maxConcurrent) cur.maxConcurrent = running;
    this.epicMetrics.set(parentId, cur);
  }

  /**
   * Flush an epic's parallelism telemetry to epic_metrics when it merges, and
   * emit a one-line summary event. This is the evidence for whether finer
   * decomposition (more tasks per stream) would actually raise concurrency, and
   * for tuning the per-epic cap.
   */
  private finalizeEpicMetrics(epic: WorkItem): void {
    const tasks = this.deps.store.listChildTasks(epic.id);
    const isVerifier = (stream: string | null): boolean =>
      !!stream && /^(qa|reviewer|security)$/.test(stream);
    const builders = tasks.filter((t) => !isVerifier(t.stream));
    const independentBuilders = builders.filter((t) => t.dependsOn.length === 0).length;
    const acc = this.epicMetrics.get(epic.id) ?? { maxConcurrent: 0, conflicts: 0 };
    const durationMs = Math.max(0, Date.now() - new Date(epic.createdAt).getTime());
    const metrics = this.deps.store.recordEpicMetrics({
      epicId: epic.id,
      projectId: this.projectId,
      taskCount: tasks.length,
      builderCount: builders.length,
      independentBuilders,
      maxConcurrent: acc.maxConcurrent,
      integrationConflicts: acc.conflicts,
      durationMs,
    });
    this.epicMetrics.delete(epic.id);
    this.emitEvent(
      this.lead().id,
      'system',
      `Epic parallelism: ${metrics.taskCount} task(s), ${metrics.independentBuilders} independent ` +
        `builder(s), peak ${metrics.maxConcurrent} concurrent, ${metrics.integrationConflicts} ` +
        `conflict(s), ${Math.round(metrics.durationMs / 1000)}s`,
      { metrics },
      epic.id,
    );
  }

  /**
   * Run `fn` after any pending integration for this epic, so merges into the
   * epic clone never overlap even while sibling tasks execute concurrently.
   */
  private integrateSerially<T>(epicId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.epicIntegrateChain.get(epicId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // Keep the chain alive but swallow errors so one failure can't poison it.
    this.epicIntegrateChain.set(
      epicId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /** Specialists eligible to build (excludes the design/product advisory roles). */
  private assignableSpecialists(): Agent[] {
    return this.specialists().filter((s) => s.name !== 'pm' && s.name !== 'architect');
  }

  /**
   * Assignable specialists SCOPED to an epic's request (FAITH-3). Fix/verify
   * tasks created after decomposition must respect the same relevance scoping the
   * initial fan-out used - otherwise a headless epic can route an acceptance-fix
   * to the ux-designer (live run #3). Verifiers stay eligible; irrelevant builders
   * (ux/frontend on a headless request, read-only roles) are dropped. Never
   * strands: falls back to all assignable specialists if scoping empties the set.
   */
  private scopedSpecialists(epic: WorkItem): Agent[] {
    const specs = this.assignableSpecialists();
    const verifiers = specs.filter((s) => /^(qa|reviewer|security)$/.test(s.name));
    const builders = specs.filter((s) => !verifiers.includes(s));
    const scope = scopeStreams(
      `${epic.title ?? ''}\n${epic.description ?? ''}`,
      builders.map((s) => s.name),
    );
    const kept = specs.filter((s) => verifiers.includes(s) || scope.keep.includes(s.name));
    return kept.length ? kept : specs;
  }

  /** Route a task to a specialist by stream tag, else to the least-loaded one. */
  private pickAgentForItem(item: WorkItem, specs: Agent[]): Agent | undefined {
    const stream = item.stream ?? /^\[(\w[\w-]*)\]/.exec(item.title)?.[1] ?? null;
    if (stream) {
      const byStream = specs.find((s) => s.name === stream);
      if (byStream) return byStream;
    }
    // No explicit stream (e.g. a task the user created and handed to the Lead):
    // infer the best-fit discipline from the title/description instead of blindly
    // load-balancing onto whichever specialist happens to be first.
    const inferred = this.inferSpecialist(item, specs);
    if (inferred) return inferred;
    const all = this.deps.store.listWorkItems(this.projectId);
    const load = (a: Agent): number =>
      all.filter(
        (w) => w.assigneeAgentId === a.id && (w.status === 'todo' || w.status === 'in_progress'),
      ).length;
    return [...specs].sort((a, b) => load(a) - load(b))[0];
  }

  /**
   * Best-effort discipline inference for an unstreamed task, matched against the
   * specialists that actually exist. Build streams are preferred over verifier
   * streams, and earlier rules win, so a "tip calculator web page" routes to
   * frontend rather than UX/QA. Returns undefined when nothing matches.
   */
  private inferSpecialist(item: WorkItem, specs: Agent[]): Agent | undefined {
    const text = `${item.title} ${item.description ?? ''}`.toLowerCase();
    const rules: [string, RegExp][] = [
      [
        'frontend',
        /\b(frontend|front-end|ui|css|html|react|vue|component|page|styles?|layout|button|form|responsive|tailwind)\b/,
      ],
      [
        'backend',
        /\b(backend|back-end|api|server|endpoint|database|db|sql|route|controller|persistence|migration)\b/,
      ],
      [
        'ux',
        /\b(ux|wireframe|mockup|usability|user experience|user flow|design system|figma|accessibility|wcag)\b/,
      ],
      ['data', /\b(data|etl|analytics|dataset|pipeline|warehouse|schema)\b/],
      [
        'devops',
        /\b(devops|ci\/cd|\bci\b|\bcd\b|pipeline|deploy|docker|kubernetes|k8s|infra|infrastructure|workflow)\b/,
      ],
      ['docs', /\b(docs?|documentation|readme|guide|changelog|tutorial)\b/],
      [
        'security',
        /\b(security|vulnerab|xss|csrf|owasp|encryption|auth[nz]?|authentication|authorization)\b/,
      ],
      ['qa', /\b(qa|e2e|regression|test coverage|test plan|quality assurance)\b/],
      ['researcher', /\b(research|investigate|spike|evaluate options|feasibility)\b/],
    ];
    for (const [name, re] of rules) {
      if (re.test(text)) {
        const a = specs.find((s) => s.name === name);
        if (a) return a;
      }
    }
    return undefined;
  }

  /**
   * Active supervision: the Lead doesn't just nudge - it engages. A blocked agent
   * is invoked directly to resume; if it has accumulated unrecoverable trouble
   * signals, the Lead restarts its session (once) and re-drives the work.
   */
  private superviseAgents(): void {
    const now = Date.now();
    for (const a of this.specialists()) {
      if (a.status !== 'blocked') continue;
      const last = this.leadNudges.get(a.id) ?? 0;
      if (now - last < 60_000) continue;
      this.leadNudges.set(a.id, now);
      const trouble = this.troubleSignal(a.id);
      if (trouble >= ProjectOrchestrator.RESTART_THRESHOLD && !this.restartedOnce.has(a.id)) {
        this.restartedOnce.add(a.id);
        void this.restartAgentSession(
          a.id,
          'stayed blocked without making progress after repeated attempts',
        );
        continue;
      }
      void this.reviveBlockedAgent(a);
    }
  }

  /** Register an unrecoverable trouble signal for an agent; returns the new count. */
  private troubleSignal(agentId: string): number {
    const n = (this.agentTrouble.get(agentId) ?? 0) + 1;
    this.agentTrouble.set(agentId, n);
    return n;
  }

  /** Clear an agent's trouble state after it makes real progress. */
  private clearTrouble(agentId: string): void {
    this.agentTrouble.delete(agentId);
    this.restartedOnce.delete(agentId);
    this.leadNudges.delete(agentId);
  }

  /** The Lead invokes a blocked agent directly to surface the blocker and resume. */
  private async reviveBlockedAgent(agent: Agent): Promise<void> {
    const main = this.ensureMainThread();
    const lead = this.lead();
    this.postMessage(
      main.id,
      lead,
      `@${agent.displayName} you look blocked - I'm stepping in. Tell me the specific blocker ` +
        `and what you've tried; I'll unblock you or pull in the right people. Meanwhile, resume ` +
        `on your current task and make concrete progress.`,
    );
    try {
      await this.actor(agent).ask(
        `The Team Lead is checking in because you appear blocked. State your single biggest ` +
          `blocker in one line, then take the next concrete step on your assigned work. If you ` +
          `truly cannot proceed, ask a specific question.`,
        main.id,
        null,
      );
    } catch {
      /* the manager tick must never crash */
    }
  }

  /** Marker embedded in a task description once the Lead has recorded an unblock decision. */
  private static readonly LEAD_DECISION_MARKER = '<!--lead-decision-->';

  /** True if the Lead already tried to unblock this item (in-memory OR persisted across restart). */
  private alreadyLeadAssisted(item: WorkItem): boolean {
    if (this.leadAssisted.has(item.id)) return true;
    return (item.description ?? '').includes(ProjectOrchestrator.LEAD_DECISION_MARKER);
  }

  /**
   * The Team Lead steps in for a specialist that produced no deliverable, instead
   * of parking the run on the human. On the FIRST assist it MAKES the missing
   * (reversible) decisions - tech stack, file layout, conventions - writes a
   * concrete buildable spec into the task, posts it to the agent, and re-queues
   * the task for a Lead-guided re-drive. Assistance is one-shot per item
   * (`alreadyLeadAssisted`), so the human prompt remains the guaranteed backstop.
   */
  private async leadResolveBlocker(agent: Agent, item: WorkItem, reason: string): Promise<void> {
    const firstTime = !this.alreadyLeadAssisted(item);
    this.leadAssisted.add(item.id);
    const lead = this.lead();
    const main = this.ensureMainThread();

    if (firstTime) {
      const notes = this.deps.store
        .listNotes(agent.id)
        .slice(0, 2)
        .map((n) => n.content)
        .join('\n\n')
        .slice(0, 1500);
      const prompt =
        `${agent.displayName} is blocked on "${item.title}" (${reason}) and produced no code.\n` +
        `Their latest notes:\n"""\n${notes || '(none)'}\n"""\n\n` +
        `You are the Team Lead. UNBLOCK them now by MAKING the decisions they are missing - ` +
        `pick concrete, reversible defaults (tech stack, libraries, file/dir layout, conventions) ` +
        `rather than asking anyone. Reply with a short, buildable spec: the stack to use, the exact ` +
        `files/components to create, and the acceptance for this slice. Be decisive and specific.`;
      let decision = '';
      try {
        decision = (await this.actor(lead).ask(prompt, main.id, item.id)).trim();
      } catch {
        /* never crash the tick - fall through to the generic directive */
      }
      const guidance =
        decision ||
        `Use a conventional default stack and ship the smallest working slice for "${item.title}". ` +
          `Make any remaining minor decisions yourself; do not wait for clarification.`;
      const patched = `${item.description ?? ''}\n\n${ProjectOrchestrator.LEAD_DECISION_MARKER}\nTeam Lead decision (unblock):\n${guidance}`.slice(
        0,
        8000,
      );
      const updated = this.deps.store.updateWorkItem(item.id, { description: patched });
      if (updated)
        this.deps.bus.publish({
          type: 'workitem.updated',
          projectId: this.projectId,
          workItem: updated,
        });
      this.emitEvent(
        agent.id,
        'system',
        `Team Lead stepped in with a decision to unblock "${item.title}"`,
        { decision: guidance },
        item.id,
      );
      this.postMessage(
        main.id,
        lead,
        `@${agent.displayName} you're blocked - here's the call so you can proceed:\n\n${guidance}\n\n` +
          `Implement this now; make any remaining minor decisions yourself.`,
      );
    } else {
      this.postMessage(
        main.id,
        lead,
        `@${agent.displayName} re-driving "${item.title}" now with the guidance above - make concrete progress.`,
      );
    }

    // Clear any parked no-code question so the human prompt disappears, then re-queue.
    this.resolveQuestionForItem(item.id, 'Retry');
    this.awaitingInput.delete(item.id);
    this.setStatus(agent.id, 'idle');
    if (!this.paused) {
      this.moveItem(item.id, 'todo');
      this.pokeLead();
    } else {
      this.moveItem(item.id, 'todo');
      this.postMessage(
        main.id,
        lead,
        `(Work is paused - "${item.title}" is queued and will re-drive when you resume.)`,
      );
    }
  }

  /**
   * Resolve a parked no-code Question for a work item: fulfil the in-memory
   * promise if it is still live, otherwise mark the DB row answered directly so a
   * take-over across a process restart never leaves a question stuck `pending`.
   * `answer` must be one of the question's valid choices.
   */
  private resolveQuestionForItem(itemId: string, answer: string): void {
    const qId = this.noCodeQuestions.get(itemId);
    if (!qId) return;
    this.noCodeQuestions.delete(itemId);
    if (this.answer(qId, answer)) return; // in-memory resolver handled it (also persists)
    const answered = this.deps.store.answerQuestion(qId, answer);
    if (answered)
      this.deps.bus.publish({
        type: 'question.updated',
        projectId: this.projectId,
        question: answered,
      });
  }

  /**
   * The user summoned the Team Lead (via an @mention). Take over every parked
   * NO-CODE blocker - and only those - by driving the Lead-resolve step, so the
   * human prompt is cleared and the Lead re-drives. Scoped strictly to
   * `noCodeQuestions`, so build/integration/epic-review escalations are untouched.
   */
  private async leadTakeOverPending(): Promise<void> {
    const pending = this.deps.store.listQuestions(this.projectId).filter((q) => q.status === 'pending');
    const pendingIds = new Set(pending.map((q) => q.id));
    const targets: Array<{ item: WorkItem; agent: Agent }> = [];
    for (const [itemId, qId] of this.noCodeQuestions) {
      if (!pendingIds.has(qId)) continue;
      const item = this.deps.store.getWorkItem(itemId);
      const agent = item?.assigneeAgentId
        ? this.deps.store.getAgent(item.assigneeAgentId)
        : undefined;
      if (item && agent) targets.push({ item, agent });
    }
    if (targets.length === 0) return;
    this.postMessage(
      this.ensureMainThread().id,
      this.lead(),
      `On it - stepping in on ${targets.length} blocked task(s) so you don't have to. I'll make the calls and re-drive.`,
    );
    for (const { item, agent } of targets) {
      await this.leadResolveBlocker(agent, item, 'you asked the Team Lead to step in');
    }
  }

  /**
   * Restart an agent whose session is stuck/unrecoverable: dispose its Copilot
   * session(s), build a fresh one on the next turn, and re-drive its work. Posts a
   * visible note as the Lead and records an event + notification.
   */
  async restartAgentSession(agentId: string, reason: string): Promise<void> {
    const agent = this.deps.store.getAgent(agentId);
    if (!agent) return;
    const actor = this.actors.get(agentId);
    if (actor) await actor.restart();
    this.agentTrouble.delete(agentId);
    this.setStatus(agentId, 'idle');
    const main = this.ensureMainThread();
    this.postMessage(
      main.id,
      this.lead(),
      `${agent.displayName}'s session wasn't recoverable (${reason}). I've torn it down and ` +
        `started a **fresh session**, and I'm re-driving the work from a clean slate.`,
    );
    this.emitEvent(agentId, 'system', `Team Lead restarted the session: ${reason}`, null, null);
    this.notify(
      'system',
      `Restarted ${agent.displayName}`,
      `The Team Lead restarted this agent's session: ${reason}`,
      `agents/${agentId}`,
      null,
      agentId,
    );
    // Re-drive any in-flight task assigned to this agent from a clean state.
    for (const item of this.deps.store.listWorkItems(this.projectId)) {
      if (item.assigneeAgentId !== agentId) continue;
      if (item.status === 'in_progress') this.moveItem(item.id, 'todo');
    }
    this.pokeLead();
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
        `**${epic.title}** - ${epic.progress ?? 0}% (${done}/${tasks.length} tasks landed)`,
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

  /**
   * Split a work item into a concrete sub-task checklist and persist each as an
   * AgentTask under this agent + work item (todo). This is the anti-hallucination
   * structure: the agent commits to an explicit scope before writing any code.
   */
  private async planSubtasks(
    agent: Agent,
    item: WorkItem,
    threadId: string,
    cwd: string | undefined,
  ): Promise<AgentTask[]> {
    const planPrompt =
      `Before writing any code, break this work item into a short checklist of 3-6 concrete, ` +
      `verifiable sub-tasks that TOGETHER fully satisfy the requirement - no missing scope and ` +
      `no invented scope. This checklist is your guard against missing requirements or ` +
      `hallucinating work.\n\n` +
      `Work item: ${item.title}\nDetails: ${item.description || '(none)'}\n\n` +
      `Reply with ONLY the checklist: one sub-task per line beginning with "- ", each a single ` +
      `concrete action. For build work, include a sub-task for unit + integration tests and one ` +
      `for verifying the acceptance criteria.`;
    let text = '';
    try {
      text = await this.actor(agent).ask(planPrompt, threadId, item.id, cwd);
    } catch {
      text = '';
    }
    let titles = this.parseChecklist(text);
    if (titles.length === 0) titles = [item.title];
    const tasks: AgentTask[] = [];
    for (const title of titles) {
      const t = this.deps.store.upsertTask({
        projectId: this.projectId,
        agentId: agent.id,
        workItemId: item.id,
        title,
        status: 'todo',
      });
      tasks.push(t);
      this.deps.bus.publish({ type: 'task.updated', projectId: this.projectId, task: t });
    }
    this.emitEvent(
      agent.id,
      'system',
      `Planned ${tasks.length} sub-task(s) for "${item.title}"`,
      null,
      item.id,
    );
    return tasks;
  }

  /** Parse a bulleted/numbered checklist into clean sub-task titles (max 8). */
  private parseChecklist(text: string): string[] {
    const out: string[] = [];
    for (const raw of text.split(/\r?\n/)) {
      const m = /^\s*(?:[-*•]|\d+[.)])\s+(.*\S)/.exec(raw);
      if (!m) continue;
      const title = (m[1] ?? '').replace(/\*\*/g, '').trim();
      if (title && title.length <= 140) out.push(title);
    }
    return out.slice(0, 8);
  }

  /** Move a set of the agent's sub-tasks to a new status and broadcast each. */
  private setSubtaskStatus(tasks: AgentTask[], status: AgentTaskStatus): void {
    for (const t of tasks) {
      const u = this.deps.store.upsertTask({
        projectId: this.projectId,
        agentId: t.agentId,
        workItemId: t.workItemId,
        title: t.title,
        status,
      });
      this.deps.bus.publish({ type: 'task.updated', projectId: this.projectId, task: u });
    }
  }

  /**
   * Snapshot of file path -> mtime under `dir`, skipping VCS/build/dependency
   * noise and ateam's own bookkeeping. Bounded so a huge repo can't stall a run.
   * Used to verify a non-worktree task actually created/edited real files.
   */
  private snapshotFiles(dir: string): Map<string, number> {
    const out = new Map<string, number>();
    const SKIP = new Set([
      '.git',
      '.ateam',
      'node_modules',
      'dist',
      'build',
      'coverage',
      '.next',
      'out',
      '.turbo',
      '.cache',
    ]);
    const CAP = 8000;
    const walk = (d: string): void => {
      if (out.size >= CAP) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (SKIP.has(e.name)) continue;
        if (e.isDirectory() && e.name.startsWith('.')) continue; // skip hidden dirs
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile()) {
          try {
            out.set(full, fs.statSync(full).mtimeMs);
          } catch {
            /* ignore unreadable file */
          }
          if (out.size >= CAP) return;
        }
      }
    };
    try {
      walk(dir);
    } catch {
      /* ignore */
    }
    return out;
  }

  /** True if any file under `dir` was added or modified since `before`. */
  private producedRealChanges(dir: string, before: Map<string, number>): boolean {
    const after = this.snapshotFiles(dir);
    for (const [file, mtime] of after) {
      const prev = before.get(file);
      if (prev === undefined || mtime > prev) return true;
    }
    return false;
  }

  private async runWorkItem(workItemId: string): Promise<void> {
    if (this.paused) return;
    const item = this.deps.store.getWorkItem(workItemId);
    if (!item || !item.assigneeAgentId) return;
    const agent = this.deps.store.getAgent(item.assigneeAgentId);
    if (!agent || agent.kind !== 'specialist') return;
    if (item.status === 'done' || item.status === 'review') return;
    // One in-flight run per item. A stalled 'in_progress' item (no active run) is
    // allowed through so the manager can resume it after a crash/restart.
    if (this.running.has(workItemId)) return;
    // Cap concurrent siblings per epic; each runs in its own isolated task clone.
    // Deferred here; the manager loop re-drives once a slot frees.
    if (item.parentId && this.epicRunning(item.parentId) >= this.epicConcurrency) return;
    this.running.add(workItemId);
    this.runningSince.set(workItemId, Date.now());
    this.lastBoardActivityAt = Date.now();
    if (item.parentId) this.recordEpicConcurrency(item.parentId);
    try {
      await this.runWorkItemInner(item.id, agent);
    } finally {
      this.running.delete(workItemId);
      this.runningSince.delete(workItemId);
      // The epic slot is now free — re-drive so the next serialized sibling (or a
      // task deferred while this one ran) starts promptly instead of waiting for
      // the periodic manager tick.
      this.pokeLead();
    }
  }

  private async runWorkItemInner(workItemId: string, agent: Agent): Promise<void> {
    const item = this.deps.store.getWorkItem(workItemId);
    if (!item) return;

    this.moveItem(item.id, 'in_progress');
    this.setProgress(item.id, Math.max(10, item.progress), agent);
    // Route this task's chatter to its epic's thread (or main for standalone work).
    const thread = this.threadForWorkItem(item);

    // Run in the epic's isolated worktree when this task belongs to an epic;
    // otherwise the task runs directly in the project checkout. Each epic task
    // gets its OWN clone, forked off the epic branch's current tip (so it sees
    // already-integrated dependency work) and committing on its own task branch;
    // its work is integrated back into the epic clone when the task completes.
    const epicWt = item.parentId ? this.epicWorktrees.get(item.parentId) : undefined;
    let worktree = epicWt;
    if (epicWt && item.parentId) {
      try {
        const tw = await this.deps.git.createTaskWorktree(
          epicWt.path,
          this.projectId,
          item.parentId,
          item.id,
        );
        this.taskWorktrees.set(item.id, tw);
        worktree = tw;
      } catch (err) {
        // Fall back to the shared epic clone (pre-5a behavior) so a clone hiccup
        // never strands the task.
        this.emitEvent(
          agent.id,
          'git',
          `Task clone failed, using the epic clone: ${err instanceof Error ? err.message : String(err)}`,
          null,
          item.id,
        );
        worktree = epicWt;
      }
    }
    const cwd = worktree?.path;
    const runDir = worktree?.path ?? this.project().repoDir;

    // PHASE 1 - plan. Before touching code the agent splits the work item into a
    // concrete sub-task checklist saved under it (agent → epic → work item →
    // tasks). This is the guard against hallucinating or missing requirements: the
    // agent commits to a scope up front and knocks each item off.
    const subtasks = await this.planSubtasks(agent, item, thread.id, cwd);
    this.setSubtaskStatus(subtasks, 'doing');
    const checklist = subtasks.map((s, i) => `${i + 1}. ${s.title}`).join('\n');

    // PHASE 2 - execute against that checklist.
    const qaStream = /^qa$/.test(item.stream ?? '');
    // Verifier streams (qa/reviewer/security) legitimately may only sign off, so
    // they are not build-gated. Declared here so the brief clauses can use it.
    const isVerifier = /^(qa|reviewer|security)$/.test(item.stream ?? '');
    const gate = !isVerifier;
    const testingClause = qaStream
      ? `This is a QA sign-off task: write end-to-end tests that exercise the feature the way an ` +
        `end user does, using the repository's existing E2E tooling (or add one if none exists). ` +
        `Only sign off after those tests actually PASS, and cite the test files, the command you ` +
        `ran, and the passing output as evidence.\n`
      : worktree
        ? `Testing is mandatory and part of "done": add unit AND integration tests for what you ` +
          `build, keep overall coverage at or above 80%, and leave the build green (typecheck, ` +
          `lint, tests).\n`
        : '';
    // The Architect's technical design for this epic (shared interfaces/contracts),
    // injected so every builder implements against the SAME plan instead of
    // guessing. Empty until the design turn lands; the first task may run without
    // it (unchanged from prior behavior), later siblings pick it up.
    //
    // I5: contract-consuming streams (frontend/backend/data) must agree on the
    // SAME shared interfaces. If the design turn hasn't landed yet, wait a BOUNDED
    // time for it before building - bounded + early-exit so throughput is never
    // blocked indefinitely, but avoiding the "build now, re-validate against the
    // late design" churn we saw in live run #2. Only when the team has an Architect.
    const contractStream = /^(frontend|backend|data)$/.test(item.stream ?? '');
    if (
      contractStream &&
      item.parentId &&
      !this.deps.store.getEpicDesign(item.parentId) &&
      this.specialists().some((s) => s.name === 'architect')
    ) {
      await this.awaitEpicDesign(item.parentId, Number(process.env.ATEAM_DESIGN_WAIT_MS ?? 45_000));
    }
    const design = item.parentId ? this.deps.store.getEpicDesign(item.parentId) : '';
    const designClause = design
      ? `\n# Epic technical design (follow it - honor these shared interfaces/contracts)\n${design}\n\n`
      : '';
    // DRIFT-2: surface the request's HARD constraints imperatively at the top of the
    // brief so the agent honors them on the first pass, instead of the deterministic
    // gate rejecting a violation and forcing a re-drive.
    const constraintClause = gate ? describeConstraints(this.epicConstraints(item.parentId)) : '';
    // DRIFT-5: scope discipline - implement EXACTLY the assigned task, no gold-plating
    // (extra endpoints, speculative features), which the reviewer would only demand be
    // removed later (build-then-remove churn).
    const scopeClause = gate
      ? `Implement EXACTLY what this task asks - the checklist scope and nothing more. Do NOT ` +
        `add endpoints, options, or features that weren't requested; extra scope will be sent ` +
        `back for removal.\n`
      : '';
    const basePrompt =
      `The Team Lead assigned you this task. Work through the checklist you defined and report ` +
      `progress to the team.\n\n` +
      constraintClause +
      `Task: ${item.title}\nDetails: ${item.description || '(none)'}\n` +
      designClause +
      `Your sub-task checklist (complete every item):\n${checklist}\n` +
      testingClause +
      scopeClause +
      (worktree
        ? `You are on branch ${worktree.branch} in an isolated worktree. Create/edit real files ` +
          `here using relative paths.\n`
        : `Create and edit REAL files in the project directory using relative paths - actually ` +
          `write the code, do not just describe the changes.\n`) +
      `When done, summarize what you did and CITE EVIDENCE: list the exact files you ` +
      `created or edited and how you verified the work (tests run, commands, checks). ` +
      `Do not claim completion unless you actually created or edited real files.`;

    // Build tasks must produce real, deliverable changes - an agent that only
    // narrates has not done the work. This holds whether the task runs in an
    // isolated epic clone or directly in the project checkout. Verifier streams
    // (qa/reviewer/security) legitimately may only sign off, so they are not gated.
    const MAX_ATTEMPTS = 2;
    // For non-worktree runs, snapshot the checkout so we can tell whether the
    // agent actually created/edited files (the clone starts clean, so it uses
    // git status instead).
    const fsBaseline = gate && !worktree ? this.snapshotFiles(runDir) : null;

    let summary = '';
    let produced = !gate;
    for (let attempt = 1; attempt <= (gate ? MAX_ATTEMPTS : 1); attempt++) {
      const firm =
        attempt > 1
          ? `\n\nYour previous attempt produced NO file changes in the working directory. You ` +
            `MUST create or edit real files (relative paths) before you summarize. Documentation ` +
            `or analysis alone does not count - write real code and tests.`
          : '';
      summary = await this.actor(agent).ask(basePrompt + firm, thread.id, item.id, cwd);
      if (!gate) break;
      produced = worktree
        ? await this.deps.git.hasWorkToIntegrate(worktree.path)
        : this.producedRealChanges(runDir, fsBaseline ?? new Map());
      // On an existing codebase, a build task whose ONLY output is documentation
      // has not made the change - require real code/tests. Fake mode intentionally
      // writes markdown deliverables, so it is exempt.
      if (
        produced &&
        worktree &&
        item.stream !== 'docs' &&
        this.deps.adapter.name !== 'fake' &&
        (await this.isBrownfieldRepo())
      ) {
        const changed = await this.deps.git.changedFiles(worktree.path);
        const committed = await this.deps.git.committedFilesAheadOfBase(worktree.path);
        const all = [...new Set([...changed, ...committed])];
        const nonDoc = all.filter((f) => !/\.md$/i.test(f) && !f.startsWith('docs/'));
        if (nonDoc.length === 0) {
          produced = false;
          this.emitEvent(
            agent.id,
            'git',
            'Only documentation changed - this build task needs real code + tests',
            null,
            item.id,
          );
        }
      }
      if (produced) break;
      this.emitEvent(
        agent.id,
        'git',
        `Produced no file changes (attempt ${attempt}/${MAX_ATTEMPTS})`,
        null,
        item.id,
      );
    }

    // The user discarded this epic while the turn was in flight: bail cleanly
    // without committing, moving, or resurrecting any deleted board item.
    if (
      (item.parentId && this.discardedEpics.has(item.parentId)) ||
      !this.deps.store.getWorkItem(item.id)
    ) {
      this.running.delete(item.id);
      this.awaitingInput.delete(item.id);
      this.setStatus(agent.id, 'idle');
      return;
    }

    // Empty build after the retry budget. Before bothering the user, the Lead
    // tries the strongest automatic recovery: restart the agent's session once
    // (fresh Copilot session, clean slate) and re-drive the task. Only if it is
    // STILL empty after that restart do we park it and escalate for guidance.
    if (gate && !produced) {
      // A FIX / remediation task (opened by a review comment or an acceptance/build
      // gate - always titled "fix:" and priority high) that produces NO diff almost
      // always means the objective is ALREADY satisfied on the branch, not that the
      // agent failed. Burning a session restart + a user escalation on it is a false
      // alarm (and exactly what happened when a truncated acceptance diff spawned a
      // phantom "unmet criteria" fix). Complete it as an audited no-op and let the
      // parent epic's gate re-adjudicate on the real tree - bounded by the epic
      // remediation cap, which stays the true backstop against genuine misses.
      const isFixTask =
        item.parentId != null && item.priority === 'high' && /(^|\]\s*)fix:/i.test(item.title);
      if (isFixTask) {
        this.recordTaskReport(item, agent, [
          {
            id: 'produced',
            status: 'skip',
            detail: 'no change needed - objective already satisfied on the branch',
          },
        ]);
        this.emitEvent(
          agent.id,
          'git',
          `No change needed for "${item.title}" - already satisfied on the branch; completing as a no-op`,
          null,
          item.id,
        );
        this.clearTrouble(agent.id);
        this.restartedForItem.delete(item.id);
        this.setStatus(agent.id, 'idle');
        this.moveItem(item.id, 'done');
        this.maybeFinishEpic(item.parentId);
        return;
      }
      this.troubleSignal(agent.id);
      this.recordTaskReport(item, agent, [
        { id: 'produced', status: 'fail', detail: `no code after ${MAX_ATTEMPTS} attempts` },
      ]);
      if (!this.restartedForItem.has(item.id)) {
        this.restartedForItem.add(item.id);
        this.emitEvent(
          agent.id,
          'system',
          `"${item.title}" produced no code after ${MAX_ATTEMPTS} attempts - restarting session`,
          null,
          item.id,
        );
        await this.restartAgentSession(
          agent.id,
          `no deliverable on "${item.title}" after ${MAX_ATTEMPTS} attempts`,
        );
        return;
      }
      // ITEM-1/3: before ever parking the run on the human, the Team Lead steps in
      // to MAKE the missing decision and re-drive (one-shot per item). Only if the
      // Lead-assisted re-drive ALSO produces nothing do we fall through to the user
      // prompt below - the guaranteed last-resort backstop.
      if (!this.alreadyLeadAssisted(item)) {
        await this.leadResolveBlocker(agent, item, 'no code after a session restart');
        return;
      }
      this.setStatus(agent.id, 'needs_input');
      this.awaitingInput.add(item.id);
      this.emitEvent(
        agent.id,
        'system',
        `"${item.title}" produced no code after a session restart - needs guidance`,
        null,
        item.id,
      );
      this.notify(
        'question',
        `Task blocked: ${item.title}`,
        `${agent.displayName} could not produce deliverable changes even after a fresh session, and needs your guidance.`,
        'board',
        item.id,
        agent.id,
      );
      void this.raiseQuestion(
        agent.id,
        `${agent.displayName} produced no code for "${item.title}" even after restarting its session. How should we proceed?`,
        ['Retry', 'Skip this task'],
        item.id,
      ).then((ans) => {
        this.noCodeQuestions.delete(item.id);
        this.awaitingInput.delete(item.id);
        this.setStatus(agent.id, 'idle');
        if (ans.toLowerCase().startsWith('skip')) {
          this.clearTrouble(agent.id);
          this.restartedForItem.delete(item.id);
          this.recordOverride(item, agent, 'task', 'user skipped: no code produced');
          this.moveItem(item.id, 'done');
          this.maybeFinishEpic(item.parentId);
        } else {
          // Retry: allow another restart cycle and let the manager re-drive it.
          this.restartedForItem.delete(item.id);
          this.moveItem(item.id, 'todo');
          this.pokeLead();
        }
      });
      return;
    }

    // MAJOR-2: pull any sibling work that integrated onto the epic branch WHILE
    // this task ran into the task clone before the deterministic gates, so a
    // fix-task's gate doesn't false-fail against a stale snapshot (the exact
    // stale-clone false-negative seen in live run). No-op unless the clone is
    // behind the epic tip; on any conflict it safely leaves the tree untouched and
    // the gates run on the current tree (status quo).
    if (gate && produced && worktree && epicWt && worktree !== epicWt && item.parentId) {
      const sync = await this.deps.git.refreshTaskFromEpic(worktree.path, epicWt.branch);
      if (sync.changed)
        this.emitEvent(
          agent.id,
          'git',
          `Synced "${item.title}" with integrated epic work before gates`,
          null,
          item.id,
        );
      else if (sync.conflict)
        this.emitEvent(
          agent.id,
          'git',
          `Could not pre-sync "${item.title}" with the epic branch (conflict) - gates run on the current tree`,
          null,
          item.id,
        );
    }

    // Per-task BUILD gate: the task's own isolated clone must compile. Each task
    // builds in ITS OWN clone (forked off the epic branch tip, so it sees
    // already-integrated dependency work), making this an honest owner-attributed
    // check with no partial-epic false-block risk - the integrated build runs
    // separately at epic finish. A script-less project is a graceful no-op.
    if (gate && produced && worktree && item.parentId) {
      {
        await this.ensureGateDeps(runDir, agent.id, item.id);
        const build = await runProjectBuild(
          runDir,
          this.project().settings.buildCommand,
          Number(process.env.ATEAM_QA_TEST_TIMEOUT_MS ?? 240_000),
        );
        if (build.ran && !build.passed) {
          const tail = build.output.split('\n').slice(-25).join('\n').slice(-2000);
          this.recordTaskReport(item, agent, [
            {
              id: 'build',
              status: 'fail',
              detail: `\`${build.command}\` did not pass`,
              evidence: tail
                ? { command: build.command, output: tail }
                : { command: build.command },
            },
          ]);
          this.emitEvent(
            agent.id,
            'system',
            `Build gate FAILED: \`${build.command}\` did not pass - blocking review`,
            tail ? { output: tail } : null,
            item.id,
          );
          this.troubleSignal(agent.id);
          // First failure: restart the session once and re-drive so the agent can
          // fix the break. Still red after that -> park and ask the user.
          if (!this.restartedForItem.has(item.id)) {
            this.restartedForItem.add(item.id);
            await this.restartAgentSession(
              agent.id,
              `build failing on "${item.title}" (${build.command})`,
            );
            return;
          }
          this.setStatus(agent.id, 'needs_input');
          this.awaitingInput.add(item.id);
          this.notify(
            'question',
            `Build blocked: ${item.title}`,
            `${agent.displayName} cannot pass the build - \`${build.command}\` is failing.`,
            'board',
            item.id,
            agent.id,
          );
          void this.raiseQuestion(
            agent.id,
            `The build is failing on "${item.title}": \`${build.command}\` did not pass even after a ` +
              `session restart. How should we proceed?`,
            ['Retry', 'Skip this task'],
          ).then((ans) => {
            this.awaitingInput.delete(item.id);
            this.setStatus(agent.id, 'idle');
            if (ans.toLowerCase().startsWith('skip')) {
              this.clearTrouble(agent.id);
              this.restartedForItem.delete(item.id);
              this.recordOverride(
                item,
                agent,
                'task',
                `user skipped: build failing (${build.command})`,
              );
              this.moveItem(item.id, 'done');
              this.maybeFinishEpic(item.parentId);
            } else {
              this.restartedForItem.delete(item.id);
              this.moveItem(item.id, 'todo');
              this.pokeLead();
            }
          });
          return;
        }
        if (build.ran)
          this.emitEvent(
            agent.id,
            'system',
            `Build gate: \`${build.command}\` passed`,
            null,
            item.id,
          );

        // Deterministic CONSTRAINT gate (FAITH-1): the code must not violate the
        // request's hard constraints ("only built-in http / no external deps",
        // "in-memory / no persistence", "headless / no UI"). This is a pure
        // filesystem scan - no LLM, no trust - so an `express` import on a
        // dependency-free task is caught HERE, before review, instead of being
        // rationalized away downstream. Same restart-once-then-escalate policy as
        // the build gate. Only fires when a constraint was actually stated.
        const constraints = this.epicConstraints(item.parentId);
        if (constraints.length > 0) {
          const violations = checkClone(runDir, constraints);
          if (violations.length > 0) {
            const summary = summarizeViolations(violations);
            this.recordTaskReport(item, agent, [
              { id: 'constraints', status: 'fail', detail: summary, evidence: { violations } },
            ]);
            this.emitEvent(
              agent.id,
              'system',
              `Constraint gate FAILED: ${summary} - blocking review`,
              { violations },
              item.id,
            );
            this.troubleSignal(agent.id);
            if (!this.restartedForItem.has(item.id)) {
              this.restartedForItem.add(item.id);
              await this.restartAgentSession(
                agent.id,
                `hard-constraint violation on "${item.title}": ${summary}`,
              );
              return;
            }
            this.setStatus(agent.id, 'needs_input');
            this.awaitingInput.add(item.id);
            this.notify(
              'question',
              `Constraint blocked: ${item.title}`,
              `${agent.displayName}'s delivery violates a hard constraint: ${summary}.`,
              'board',
              item.id,
              agent.id,
            );
            void this.raiseQuestion(
              agent.id,
              `"${item.title}" violates a hard constraint from the request (${summary}) even after a ` +
                `session restart. How should we proceed?`,
              ['Retry', 'Skip this task'],
            ).then((ans) => {
              this.awaitingInput.delete(item.id);
              this.setStatus(agent.id, 'idle');
              if (ans.toLowerCase().startsWith('skip')) {
                this.clearTrouble(agent.id);
                this.restartedForItem.delete(item.id);
                this.recordOverride(
                  item,
                  agent,
                  'task',
                  `user skipped: constraint violation (${summary})`,
                );
                this.moveItem(item.id, 'done');
                this.maybeFinishEpic(item.parentId);
              } else {
                this.restartedForItem.delete(item.id);
                this.moveItem(item.id, 'todo');
                this.pokeLead();
              }
            });
            return;
          }
          this.recordTaskReport(item, agent, [
            {
              id: 'constraints',
              status: 'pass',
              detail: `honored ${constraints.map((c) => c.kind).join(', ')}`,
            },
          ]);
          this.emitEvent(
            agent.id,
            'system',
            `Constraint gate: honored ${constraints.map((c) => c.kind).join(', ')}`,
            null,
            item.id,
          );
        }
      }
    }

    // QA sign-off is EVIDENCE-ENFORCED: a QA task cannot advance to review on a
    // narrated "looks good". If the project has a runnable test command, it must
    // actually PASS here; a failing (or timed-out) suite blocks sign-off and is
    // surfaced with the command + output. When nothing is runnable we let QA
    // proceed but record that no automated verification happened, so the Lead can
    // see the gap. This runs in the same dir the agent worked in (epic clone or
    // repo checkout), after QA has had its chance to add/fix tests.
    if (qaStream) {
      await this.ensureGateDeps(runDir, agent.id, item.id);
      const test = await runProjectTests(
        runDir,
        this.project().settings.testCommand,
        Number(process.env.ATEAM_QA_TEST_TIMEOUT_MS ?? 240_000),
      );
      if (test.ran && !test.passed) {
        const tail = test.output.split('\n').slice(-25).join('\n').slice(-2000);
        this.recordTaskReport(item, agent, [
          {
            id: 'tests',
            status: 'fail',
            detail: `\`${test.command}\` did not pass`,
            evidence: { command: test.command, output: tail },
          },
        ]);
        this.emitEvent(
          agent.id,
          'system',
          `QA gate FAILED: \`${test.command}\` did not pass - blocking sign-off`,
          tail ? { output: tail } : null,
          item.id,
        );
        this.troubleSignal(agent.id);
        // First failure: restart QA's session once and re-drive so it can fix the
        // tests/feature. Still failing after that -> park and ask the user.
        if (!this.restartedForItem.has(item.id)) {
          this.restartedForItem.add(item.id);
          await this.restartAgentSession(
            agent.id,
            `QA tests failing on "${item.title}" (${test.command})`,
          );
          return;
        }
        this.setStatus(agent.id, 'needs_input');
        this.awaitingInput.add(item.id);
        this.notify(
          'question',
          `QA blocked: ${item.title}`,
          `${agent.displayName} cannot sign off - \`${test.command}\` is failing.`,
          'board',
          item.id,
          agent.id,
        );
        void this.raiseQuestion(
          agent.id,
          `QA cannot sign off on "${item.title}": \`${test.command}\` is still failing after a session restart. How should we proceed?`,
          ['Retry', 'Skip this task'],
        ).then((ans) => {
          this.awaitingInput.delete(item.id);
          this.setStatus(agent.id, 'idle');
          if (ans.toLowerCase().startsWith('skip')) {
            this.clearTrouble(agent.id);
            this.restartedForItem.delete(item.id);
            this.recordOverride(
              item,
              agent,
              'task',
              `user skipped: QA tests failing (${test.command})`,
            );
            this.moveItem(item.id, 'done');
            this.maybeFinishEpic(item.parentId);
          } else {
            this.restartedForItem.delete(item.id);
            this.moveItem(item.id, 'todo');
            this.pokeLead();
          }
        });
        return;
      }
      const okTail = test.ran ? test.output.split('\n').slice(-8).join('\n').slice(-1000) : '';
      this.recordTaskReport(item, agent, [
        {
          id: 'tests',
          status: test.ran ? 'pass' : 'skip',
          detail: test.ran ? `\`${test.command}\` passed` : 'no test command detected',
          evidence: okTail ? { command: test.command, output: okTail } : undefined,
        },
      ]);
      this.emitEvent(
        agent.id,
        'system',
        test.ran
          ? `QA gate: \`${test.command}\` passed`
          : `QA signed off WITHOUT an automated test run (no test command detected)`,
        okTail ? { output: okTail } : null,
        item.id,
      );
    }

    // The task produced real work (or is a verifier sign-off) - clear any prior
    // trouble so a later hiccup starts a fresh recovery budget.
    this.clearTrouble(agent.id);
    // Record an audit note and commit the task's work on the epic branch.
    let completion: { branch: string; hash: string | null; files: GitFileChange[] } | null = null;
    // Integration outcome for the required `integrated` check (builders/qa). Stays
    // `skip` when no separate integration ran; resolved to pass/fail below.
    let integratedStatus: CheckStatus = 'skip';
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
          this.deps.git.taskMessage(item.stream, item.title),
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

    // Integrate this task's branch into the epic clone so the epic branch is the
    // single integrated result the epic-level gates run against. Integrations are
    // SERIALIZED per epic (two merges into one clone must never overlap) even
    // though sibling tasks now run concurrently. On a conflict the merge aborts
    // cleanly and the task is re-queued to redo its work on top of the integrated
    // tree (capped, then escalated) - the epic branch is never left half-merged.
    if (epicWt && worktree && worktree !== epicWt && item.parentId && completion?.hash) {
      const parentId = item.parentId;
      const taskWt = worktree;
      let conflict = false;
      try {
        const r = await this.integrateSerially(parentId, () =>
          this.deps.git.integrateTaskBranch(epicWt.path, epicWt.branch, taskWt.path, taskWt.branch),
        );
        this.emitEvent(
          agent.id,
          'git',
          r.ok
            ? `Integrated ${taskWt.branch} into ${epicWt.branch}`
            : `Integration ${r.conflict ? 'conflict' : 'failed'} on ${taskWt.branch}: ${r.detail}`,
          null,
          item.id,
        );
        conflict = !r.ok && r.conflict;
        integratedStatus = r.ok ? 'pass' : r.conflict ? 'skip' : 'fail';
        if (!r.ok && !r.conflict)
          this.notify(
            'system',
            `Integration failed: ${item.title}`,
            r.detail.slice(0, 200),
            'git',
            item.id,
            agent.id,
          );
      } catch (err) {
        integratedStatus = 'fail';
        this.emitEvent(
          agent.id,
          'git',
          `Integration error on ${taskWt.branch}: ${err instanceof Error ? err.message : String(err)}`,
          null,
          item.id,
        );
      }
      // The task clone has served its purpose - reclaim it.
      this.taskWorktrees.delete(item.id);
      await this.deps.git
        .removeWorktree(this.project().repoDir, taskWt.path)
        .catch(() => undefined);

      if (conflict) {
        const met = this.epicMetrics.get(parentId) ?? { maxConcurrent: 0, conflicts: 0 };
        met.conflicts += 1;
        this.epicMetrics.set(parentId, met);
        // Re-queue so the agent redoes the work in a fresh clone forked off the
        // now-integrated epic tip (where the conflicting sibling already landed).
        // ISSUE-2: give auto-recovery up to TWO re-drives before escalating - the
        // re-drive forks off the fresh tip AND the pre-gate refresh syncs integrated
        // siblings in, so most transient overlaps resolve without a human; only a
        // genuine same-region semantic conflict reaches the user.
        const n = (this.taskConflicts.get(item.id) ?? 0) + 1;
        this.taskConflicts.set(item.id, n);
        this.setSubtaskStatus(subtasks, 'todo');
        if (n >= 3) {
          this.setStatus(agent.id, 'needs_input');
          this.awaitingInput.add(item.id);
          this.notify(
            'question',
            `Integration conflict: ${item.title}`,
            `${agent.displayName}'s work keeps conflicting with a sibling on merge.`,
            'board',
            item.id,
            agent.id,
          );
          void this.raiseQuestion(
            agent.id,
            `"${item.title}" conflicts with a sibling task's changes on integration, even after a ` +
              `retry. How should we proceed?`,
            ['Retry', 'Skip this task'],
          ).then((ans) => {
            this.awaitingInput.delete(item.id);
            this.setStatus(agent.id, 'idle');
            this.taskConflicts.delete(item.id);
            if (ans.toLowerCase().startsWith('skip')) {
              this.recordOverride(
                item,
                agent,
                'task',
                'user skipped: persistent integration conflict',
              );
              this.moveItem(item.id, 'done');
              this.maybeFinishEpic(parentId);
            } else {
              this.moveItem(item.id, 'todo');
              this.pokeLead();
            }
          });
        } else {
          this.moveItem(item.id, 'todo');
          this.pokeLead();
        }
        return;
      }
      this.taskConflicts.delete(item.id);
    }

    // INTEGRATED is a required check for builders/qa within an epic: if a real
    // integration attempt FAILED, the task may not reach review (its work isn't on
    // the epic branch). `skip` (no separate integration - same-clone/standalone)
    // and `pass` are both fine; empty builders are already caught by `produced`.
    const requiresIntegration =
      gate &&
      item.parentId != null &&
      requiredChecks(item.stream ?? null, 'task').includes('integrated');
    if (requiresIntegration && integratedStatus === 'fail') {
      this.recordTaskReport(item, agent, [
        {
          id: 'integrated',
          status: 'fail',
          detail: 'work did not land on the epic branch (no commit or merge failed)',
        },
      ]);
      this.emitEvent(
        agent.id,
        'system',
        `Integration gate FAILED: "${item.title}" did not land on the epic branch - blocking review`,
        null,
        item.id,
      );
      this.troubleSignal(agent.id);
      if (!this.restartedForItem.has(item.id)) {
        this.restartedForItem.add(item.id);
        await this.restartAgentSession(agent.id, `work did not integrate on "${item.title}"`);
        return;
      }
      this.setStatus(agent.id, 'needs_input');
      this.awaitingInput.add(item.id);
      this.notify(
        'question',
        `Integration blocked: ${item.title}`,
        `${agent.displayName}'s work did not land on the epic branch.`,
        'board',
        item.id,
        agent.id,
      );
      void this.raiseQuestion(
        agent.id,
        `"${item.title}" did not integrate into the epic branch even after a restart. How should we proceed?`,
        ['Retry', 'Skip this task'],
      ).then((ans) => {
        this.awaitingInput.delete(item.id);
        this.setStatus(agent.id, 'idle');
        this.restartedForItem.delete(item.id);
        if (ans.toLowerCase().startsWith('skip')) {
          this.recordOverride(item, agent, 'task', 'user skipped: work did not integrate');
          this.moveItem(item.id, 'done');
          this.maybeFinishEpic(item.parentId);
        } else {
          this.moveItem(item.id, 'todo');
          this.pokeLead();
        }
      });
      return;
    }

    // Passing task report: the single durable record that authorizes advancement.
    this.recordTaskReport(item, agent, [
      {
        id: 'produced',
        status: gate ? 'pass' : 'skip',
        detail: gate ? 'delivered changes' : 'verifier',
      },
      {
        id: 'integrated',
        status: integratedStatus,
        detail:
          integratedStatus === 'pass'
            ? 'landed on the epic branch'
            : 'no separate integration (n/a)',
      },
    ]);
    // Every sub-task in the checklist is now complete.
    this.setSubtaskStatus(subtasks, 'done');
    const latest = this.deps.store.getWorkItem(item.id);
    if (latest && latest.status === 'in_progress') this.moveItem(item.id, 'review');
    this.setProgress(item.id, 100, agent);
    // Post a structured, evidence-backed completion report to the team so the
    // branch/commit/files are visible and "done" can't hide an empty branch.
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

  /** Render a `+a / -r` line for a changed file (binary shows `bin`). */
  private fileLine(f: GitFileChange): string {
    const stat = f.added < 0 || f.removed < 0 ? 'bin' : `+${f.added} / -${f.removed}`;
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
    const thread = this.threadForWorkItem(item);
    // Exclude ateam bookkeeping from the deliverable evidence.
    const files = (completion?.files ?? []).filter((f) => !f.path.startsWith('.ateam/'));
    const lines: string[] = [];
    const header =
      completion && !completion.hash && isVerifier
        ? `### ✅ Task complete - ${item.title} _(verification - no code changes)_`
        : `### ✅ Task complete - ${item.title}`;
    lines.push(header);
    lines.push(
      `**Agent:** ${agent.emoji} ${agent.displayName} · **Stream:** ${item.stream ?? '-'}`,
    );
    if (completion?.branch) lines.push(`**Branch:** \`${completion.branch}\``);
    if (completion?.hash) {
      lines.push(
        `**Commit:** \`${completion.hash.slice(0, 8)}\` - ${this.deps.git.taskMessage(item.stream, item.title)}`,
      );
    }
    if (files.length > 0) {
      lines.push(`**Files changed (${files.length}):**`);
      for (const f of files.slice(0, 20)) lines.push(this.fileLine(f));
      if (files.length > 20) lines.push(`- ...and ${files.length - 20} more`);
    } else if (!isVerifier && completion) {
      lines.push(`**Files changed:** _none_`);
    }
    lines.push('');
    lines.push('**Evidence**');
    lines.push(summary.trim() || '_(no summary provided)_');
    this.postMessage(thread.id, agent, lines.join('\n'));
  }

  /** Post the epic-level merge report (branch, commit count, files) to the team. */
  private postEpicCompletion(
    epic: WorkItem,
    branch: string,
    base: string,
    commits: GitCommit[],
    files: GitFileChange[],
  ): void {
    const thread = this.threadForWorkItem(epic);
    const lead = this.lead();
    const lines: string[] = [];
    lines.push(`### 🚀 Epic merged - ${epic.title}`);
    lines.push(
      `**Branch:** \`${branch || '-'}\` → \`${base || 'main'}\` · ` +
        `**${commits.length}** commit${commits.length === 1 ? '' : 's'} · ` +
        `**${files.length}** file${files.length === 1 ? '' : 's'} changed`,
    );
    if (commits.length > 0) {
      lines.push('**Commits:**');
      for (const c of commits.slice(0, 15)) lines.push(`- \`${c.hash.slice(0, 8)}\` ${c.subject}`);
      if (commits.length > 15) lines.push(`- ...and ${commits.length - 15} more`);
    }
    if (files.length > 0) {
      lines.push('**Files:**');
      for (const f of files.slice(0, 20)) lines.push(this.fileLine(f));
      if (files.length > 20) lines.push(`- ...and ${files.length - 20} more`);
    }
    const criteria = this.deps.store.listCriteria(epic.id);
    if (criteria.length > 0) {
      const met = criteria.filter((c) => c.status === 'met').length;
      lines.push(`**Acceptance:** ${met}/${criteria.length} criteria met`);
      for (const c of criteria) {
        const mark = c.status === 'met' ? '✅' : c.status === 'failed' ? '❌' : '•';
        lines.push(`- ${mark} ${c.text}`);
      }
    }
    this.postMessage(thread.id, lead, lines.join('\n'));
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
          `Dependencies met - starting ${t.title}`,
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
    // Parked awaiting the user's acceptance decision - don't re-trigger review
    // (which would re-run the gate and spam the same question every tick).
    if (this.awaitingInput.has(parentId)) return;
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
    const thread = this.threadForWorkItem(epic);
    const lead = this.lead();
    const repoDir = this.project().repoDir;
    const branch = epic.branch ?? '';
    const wt = this.epicWorktrees.get(epic.id);

    if (this.deps.store.getWorkItem(epic.id)?.status !== 'review') this.moveItem(epic.id, 'review');

    let diff = '';
    let fileStat = '';
    if (branch && wt) {
      try {
        const base = await this.deps.git.currentBranch(repoDir);
        diff = await this.deps.git.branchDiff(wt.path, base);
        fileStat = await this.deps.git.branchFileStat(wt.path, base);
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
        description: `Epic "${epic.title}" ready for review.`,
        branch,
        baseBranch: base,
        diff,
      });
      prId = pr.id;
      this.epicPr.set(epic.id, prId);
      this.emitEvent(lead.id, 'pull_request', `Raised PR for "${epic.title}"`, null, epic.id);
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

    // No independent reviewer available → Lead self-approves, subject to the
    // acceptance gate.
    if (reviewer.id === lead.id) {
      await this.finalizeEpic(epic, prId, lead, repoDir, branch, wt, diff);
      return;
    }

    // The reviewer (Architect) inspects the diff and files routed comments via
    // the add_review_comment tool. We resolve the PR from reviewContext during
    // the ask.
    this.reviewContext.set(reviewer.id, { epicId: epic.id, prId });
    const reviewCriteria = this.deps.store.listCriteria(epic.id);
    const critBlock = reviewCriteria.length
      ? `Acceptance criteria the delivery must satisfy:\n` +
        reviewCriteria.map((c, i) => `${i + 1}. ${c.text}`).join('\n') +
        `\n\n`
      : '';
    // DRIFT-4: surface the request's HARD CONSTRAINTS so the reviewer conforms to
    // them AND never demands a "fix" that would BREAK one (e.g. asking for a
    // dependency, a datastore, or a UI the request forbids).
    const reviewConstraints = describeConstraints(this.epicConstraints(epic.id));
    const constraintBlock = reviewConstraints ? `${reviewConstraints}\n` : '';
    const prompt =
      `Please review the pull request for epic "${epic.title}".\n\n` +
      `ORIGINAL REQUEST (the source of truth - review against THIS, not against ` +
      `whatever the team happened to build):\n${(epic.description ?? '').slice(0, 2000)}\n\n` +
      constraintBlock +
      critBlock +
      (fileStat
        ? `Files delivered (COMPLETE list - the content diff below may be truncated, ` +
          `this file list is not):\n${fileStat}\n\n`
        : '') +
      `Diff:\n${diff.slice(0, 6000) || '(no textual diff)'}\n\n` +
      `You are reviewing INSIDE the delivered working tree - if the content diff is ` +
      `truncated, open the files listed above to see the full implementation before ` +
      `judging. `
      +
      `Check CONFORMANCE to the request FIRST, before any code-quality nits. File a ` +
      `BLOCKING comment for ANY deviation from what the user actually asked for - ` +
      `especially the request's HARD CONSTRAINTS: persistence model (e.g. in-memory vs ` +
      `file/db), dependency policy (e.g. "no external dependencies"), language/runtime, ` +
      `and the exact required interface/endpoints. Building something the request did ` +
      `not ask for (e.g. a UI or a datastore it forbade) is itself a blocking defect. ` +
      `Then review the design and quality bar.\n\n` +
      `Do NOT request changes that would VIOLATE a hard constraint above (e.g. do not ` +
      `ask for a new dependency, a database/disk persistence, or a UI when the request ` +
      `forbids them) - if a quality improvement would require breaking a stated ` +
      `constraint, do not demand it.\n\n` +
      `For every issue, call add_review_comment(body, targetStream) routed to the responsible ` +
      `stream. If it meets the bar AND conforms to the request, leave no comments and it ` +
      `will be approved.`;
    try {
      await this.actor(reviewer).ask(prompt, thread.id, epic.id, wt?.path);
    } finally {
      this.reviewContext.delete(reviewer.id);
    }

    const open = this.deps.store.listPrComments(prId).filter((c) => c.status === 'open');

    // Clean bill of health from review → subject to the acceptance gate, merge.
    if (open.length === 0) {
      await this.finalizeEpic(epic, prId, lead, repoDir, branch, wt, diff);
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

    // F1b: converge-or-escalate. Park + ask the user when the round cap is hit OR
    // the cumulative review-fix budget would be exceeded - so a heavily-reviewed
    // epic can't grind forever (rounds rarely complete under a single serial owner).
    const budget = reviewBudgetDecision({
      iter,
      maxIter: this.maxReviewIter,
      cumulativeFixes: this.epicReviewFixTotal.get(epic.id) ?? 0,
      maxFixes: this.maxReviewFixes,
      openCount: open.length,
    });
    if (budget.action === 'escalate') {
      const list = open.map((c) => `- ${c.body.slice(0, 140)}`).join('\n');
      this.awaitingInput.add(epic.id);
      this.notify(
        'question',
        `Review blocked: ${epic.title}`,
        `${open.length} review comment(s) still open after ${iter} rounds.`,
        'git',
        epic.id,
        lead.id,
      );
      void this.raiseQuestion(
        lead.id,
        `Epic "${epic.title}" still has ${open.length} open review comment(s) after ${iter} ` +
          `round(s) [${budget.reason}]:\n${list}\n\nMerge anyway, or keep working on them? (Merging waives these ` +
          `review comments, but the deterministic build / constraint / contract-probe gates ` +
          `still run before the merge.)`,
        ['Keep working', 'Merge anyway'],
      ).then(async (ans) => {
        this.awaitingInput.delete(epic.id);
        if (ans.toLowerCase().startsWith('merge')) {
          // OVERRIDE-1: the user waives the leftover SUBJECTIVE review comments, but
          // this must NOT skip the OBJECTIVE gates (integrated build / constraints /
          // acceptance probe) - otherwise a broken contract could slip through the
          // review escape hatch (the MAJOR-1 blind spot via the back door). So we
          // resolve the comments and fall through the normal finalize gates WITHOUT
          // setting `forcedAccept`. If an objective gate then fails, its own
          // escalation asks the user again, specifically about that gate.
          for (const c of open) this.resolveComment(c.id);
          this.epicReviewIter.delete(epic.id);
          this.epicReviewFixTotal.delete(epic.id);
          this.recordOverride(
            epic,
            lead,
            'epic',
            `user waived ${open.length} open review comment(s) after ${iter} rounds; objective gates still enforced`,
          );
          this.emitEvent(
            lead.id,
            'pull_request',
            `Waived ${open.length} review comment(s) after ${iter} rounds (user approved); ` +
              `running build / constraint / contract-probe gates before merge`,
            null,
            epic.id,
          );
          await this.finalizeEpic(epic, prId, lead, repoDir, branch, wt, diff);
        } else {
          // Give the team another budget of rounds to actually address the comments.
          this.epicReviewIter.set(epic.id, 0);
          this.epicReviewFixTotal.set(epic.id, 0);
          this.assignReviewFixes(epic, open, lead);
          this.pokeLead();
        }
      });
      return;
    }

    // The Team Lead turns each open comment into a fix task assigned to the
    // responsible stream. When those tasks land, comments resolve and review
    // re-runs automatically.
    this.assignReviewFixes(epic, open, lead);
  }

  /**
   * Turn each open review comment into a high-priority fix task assigned to the
   * responsible stream. When those tasks land, the comments resolve and review
   * re-runs automatically.
   */
  private assignReviewFixes(epic: WorkItem, open: PrComment[], lead: Agent): void {
    let created = 0;
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
        description: `Review comment on "${epic.title}":\n\n${c.body}`,
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
        `Assigned fix "${fix.title}"${target ? ` → ${target.displayName}` : ''}`,
        null,
        fix.id,
      );
      if (target) void this.onItemAssigned(fix.id).catch(() => undefined);
      else this.pokeLead();
      created += 1;
    }
    if (created > 0)
      this.epicReviewFixTotal.set(
        epic.id,
        (this.epicReviewFixTotal.get(epic.id) ?? 0) + created,
      );
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

  /**
   * The single merge decision point. Evaluate the epic's acceptance criteria
   * against the delivered work; merge only when every criterion is met. Unmet
   * criteria are routed back as fix work (capped, then escalated to the user)
   * instead of being silently merged. Epics with no recorded criteria (e.g. a
   * greenfield request without a PM) merge as before.
   */
  private async finalizeEpic(
    epic: WorkItem,
    prId: string,
    lead: Agent,
    repoDir: string,
    branch: string,
    wt: { branch: string; path: string } | undefined,
    diff: string,
  ): Promise<void> {
    // A user "merge anyway" override skips the remaining gates - but is RECORDED
    // as an audited epic-scoped override, never silent.
    if (this.forcedAccept.has(epic.id)) {
      this.recordOverride(epic, lead, 'epic', 'user chose to merge despite unmet epic gates');
      this.forcedAccept.delete(epic.id);
      this.epicRemediationIter.delete(epic.id);
      await this.approveAndMerge(epic, prId, lead, repoDir, branch);
      return;
    }

    // Integrated build gate: the fully-integrated epic clone must compile before
    // we judge acceptance or merge. Concurrent siblings can each build in
    // isolation yet break once merged together - this is the catch. A script-less
    // project is a graceful no-op.
    let buildStatus: CheckStatus = 'skip';
    if (wt) {
      await this.ensureGateDeps(wt.path, lead.id, epic.id);
      const built = await runProjectBuild(
        wt.path,
        this.project().settings.buildCommand,
        Number(process.env.ATEAM_QA_TEST_TIMEOUT_MS ?? 240_000),
      );
      if (built.ran && !built.passed) {
        this.recordEpicReport(epic, lead, [
          { id: 'integrated-build', status: 'fail', detail: built.command },
        ]);
        await this.handleIntegratedBuildFailure(epic, built, lead);
        return;
      }
      if (built.ran) {
        buildStatus = 'pass';
        this.emitEvent(
          lead.id,
          'system',
          `Integrated build passed: \`${built.command}\``,
          null,
          epic.id,
        );
      }
    }

    // Integrated CONSTRAINT gate (MERGE AUTHORITY): the task-clone constraint gate
    // is a pre-filter; the integrated epic tree is the authority. Re-scan it so a
    // violation that survived integration (or emerged from merging siblings) can
    // never merge on agent narration alone.
    let constraintStatus: CheckStatus = 'skip';
    const cons = wt ? this.epicConstraints(epic.id) : [];
    if (wt && cons.length > 0) {
      const violations = checkClone(wt.path, cons);
      if (violations.length > 0) {
        const summary = summarizeViolations(violations);
        this.recordEpicReport(epic, lead, [
          { id: 'integrated-build', status: buildStatus, detail: '' },
          { id: 'integrated-constraints', status: 'fail', detail: summary },
        ]);
        await this.handleIntegratedConstraintFailure(epic, summary, lead);
        return;
      }
      constraintStatus = 'pass';
    }

    let acceptStatus: CheckStatus = 'skip';
    const criteria = this.deps.store.listCriteria(epic.id);
    if (criteria.length > 0) {
      const gate = await this.evaluateAcceptance(epic, criteria, wt, diff);
      if (!gate.ok) {
        this.recordEpicReport(epic, lead, [
          { id: 'integrated-build', status: buildStatus, detail: '' },
          { id: 'integrated-constraints', status: constraintStatus, detail: '' },
          { id: 'acceptance', status: 'fail', detail: `${gate.unmet.length} unmet` },
        ]);
        await this.handleUnmetCriteria(epic, gate.unmet, lead);
        return;
      }
      acceptStatus = 'pass';
    }

    // Deterministic ACCEPTANCE PROBE (MAJOR-1): a spec-derived, machine-checkable
    // contract check run against the integrated tree, INDEPENDENT of the builders'
    // own unit tests (which can pass a wrong contract). Exit 0 = accepted; non-zero
    // BLOCKS the merge. Absent (no acceptanceCommand + no committed
    // `.ateam/acceptance.mjs`) => `skip`, so a probe-less epic merges as before.
    let probeStatus: CheckStatus = 'skip';
    if (wt) {
      const probe = await runAcceptanceProbe(
        wt.path,
        this.project().settings.acceptanceCommand,
        Number(process.env.ATEAM_QA_TEST_TIMEOUT_MS ?? 240_000),
      );
      if (probe.ran && !probe.passed) {
        this.recordEpicReport(epic, lead, [
          { id: 'integrated-build', status: buildStatus, detail: '' },
          { id: 'integrated-constraints', status: constraintStatus, detail: '' },
          { id: 'acceptance', status: acceptStatus, detail: '' },
          {
            id: 'acceptance-probe',
            status: 'fail',
            detail: probe.command,
            evidence: { output: probe.output.split('\n').slice(-25).join('\n').slice(-2000) },
          },
        ]);
        await this.handleFailedAcceptanceProbe(epic, probe, lead);
        return;
      }
      if (probe.ran) {
        probeStatus = 'pass';
        this.emitEvent(
          lead.id,
          'system',
          `Acceptance probe passed: \`${probe.command}\``,
          null,
          epic.id,
        );
      }
    }

    // All merge-authority gates cleared - record the passing epic report (the
    // durable proof behind this merge) before approving.
    this.recordEpicReport(epic, lead, [
      { id: 'integrated-build', status: buildStatus, detail: '' },
      { id: 'integrated-constraints', status: constraintStatus, detail: '' },
      { id: 'acceptance', status: acceptStatus, detail: '' },
      { id: 'acceptance-probe', status: probeStatus, detail: '' },
    ]);
    this.epicRemediationIter.delete(epic.id);
    await this.approveAndMerge(epic, prId, lead, repoDir, branch);
  }

  /**
   * Assemble, persist, and emit an epic-scoped (MERGE-AUTHORITY) verification
   * report - the durable record behind a merge decision, distinct from the
   * per-task pre-filter reports. `integrated-tests` is left `skip` (n/a): tests
   * run in the per-task QA gate; this scope owns build + constraints + acceptance.
   */
  private recordEpicReport(
    epic: WorkItem,
    lead: Agent,
    raw: Array<{ id: string; status: CheckStatus; detail: string; evidence?: unknown }>,
  ): void {
    const checks = assembleChecks(null, 'epic', raw);
    this.persistReport(
      makeReport({ workItemId: epic.id, agentId: lead.id, stream: null, scope: 'epic' }, checks),
    );
  }

  /**
   * The integrated epic tree violates a hard constraint at the merge authority.
   * Route a fix (sharing the remediation budget); after the cap, park and ask the
   * user to merge anyway or keep working.
   */
  private async handleIntegratedConstraintFailure(
    epic: WorkItem,
    summary: string,
    lead: Agent,
  ): Promise<void> {
    const iter = (this.epicRemediationIter.get(epic.id) ?? 0) + 1;
    this.epicRemediationIter.set(epic.id, iter);
    this.emitEvent(
      lead.id,
      'system',
      `Integrated constraint gate FAILED: ${summary} - blocking merge`,
      null,
      epic.id,
    );
    const fixTitle = 'fix: integrated constraint violation';
    const fixBody =
      `The integrated epic violates a hard constraint: ${summary}. Fix the delivery so it ` +
      `honors the constraint (do not merely suppress the check).`;
    if (iter >= ProjectOrchestrator.MAX_REMEDIATION_ITER) {
      this.awaitingInput.add(epic.id);
      this.notify(
        'question',
        `Constraint blocked: ${epic.title}`,
        summary,
        'board',
        epic.id,
        lead.id,
      );
      void this.raiseQuestion(
        lead.id,
        `The integrated epic "${epic.title}" still VIOLATES a hard constraint (${summary}) after ` +
          `${iter} rounds. Merge anyway, or keep working on it?`,
        ['Keep working', 'Merge anyway'],
      ).then((ans) => {
        this.awaitingInput.delete(epic.id);
        if (ans.toLowerCase().startsWith('merge')) {
          this.forcedAccept.add(epic.id);
          this.epicRemediationIter.delete(epic.id);
        } else {
          this.epicRemediationIter.set(epic.id, 0);
          this.createFixTask(epic, fixTitle, fixBody, lead);
        }
        this.pokeLead();
      });
      return;
    }
    this.createFixTask(epic, fixTitle, fixBody, lead);
    this.pokeLead();
  }

  /**
   * Assemble, persist (audit trail), and emit a task-scoped verification report
   * from the raw check outcomes the gate just computed. This is the single place
   * a gate decision becomes a durable, queryable record.
   */
  private recordTaskReport(
    item: WorkItem,
    agent: Agent,
    raw: Array<{ id: string; status: CheckStatus; detail: string; evidence?: unknown }>,
  ): ReturnType<typeof makeReport> {
    const checks = assembleChecks(item.stream ?? null, 'task', raw);
    const report = makeReport(
      { workItemId: item.id, agentId: agent.id, stream: item.stream ?? null, scope: 'task' },
      checks,
    );
    this.persistReport(report);
    return report;
  }

  /** Record an explicit, audited override (user Skip / merge-anyway). */
  private recordOverride(item: WorkItem, agent: Agent, scope: GateScope, reason: string): void {
    this.persistReport(
      overrideReport(
        { workItemId: item.id, agentId: agent.id, stream: item.stream ?? null, scope },
        reason,
      ),
    );
  }

  private persistReport(report: ReturnType<typeof makeReport>): void {
    this.deps.store.insertVerification({
      projectId: this.projectId,
      workItemId: report.workItemId,
      agentId: report.agentId,
      scope: report.scope,
      stream: report.stream,
      passed: report.passed,
      outcome: report.outcome,
      checks: report.checks,
    });
    this.emitEvent(
      report.agentId,
      'verification',
      `Verification (${report.scope}): ${summarizeReport(report)}`,
      { report: report as unknown as Record<string, unknown> },
      report.workItemId,
    );
  }

  /**
   * Detect the machine-checkable hard constraints for an epic from its request
   * text + acceptance criteria. Memoized per epic (the source text is immutable
   * once decomposed) so the per-task constraint gate stays cheap. Returns [] when
   * the parent isn't an epic or nothing is stated.
   */
  private epicConstraints(parentId: string | null): Constraint[] {
    if (!parentId) return [];
    const cached = this.epicConstraintCache.get(parentId);
    if (cached) return cached;
    const epic = this.deps.store.getWorkItem(parentId);
    if (!epic || epic.kind !== 'epic') return [];
    const texts: Array<string | null | undefined> = [epic.title, epic.description];
    for (const c of this.deps.store.listCriteria(parentId)) texts.push(c.text);
    const cons = detectConstraints(texts);
    this.epicConstraintCache.set(parentId, cons);
    return cons;
  }

  private readonly epicConstraintCache = new Map<string, Constraint[]>();

  /**
   * Poll for the epic's Architect design up to timeoutMs, resolving early the
   * moment it lands (or the epic is discarded). Bounded so a contract-consuming
   * builder never waits forever on a design turn that stalls.
   */
  private async awaitEpicDesign(epicId: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() < deadline) {
      if (this.discardedEpics.has(epicId)) return;
      if (this.deps.store.getEpicDesign(epicId)) return;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  /**
   * Install a gate directory's dependencies if they are missing before a
   * build/test gate runs there. The integrated epic clone and freshly-forked task
   * clones carry source only (node_modules is git-ignored), so a project whose
   * gate needs installed tooling (tsc/vitest/tsx) would spuriously fail. No-op
   * once node_modules exists. Best-effort - emits an event when it installs.
   */
  private async ensureGateDeps(
    dir: string,
    agentId: string,
    workItemId: string | null,
  ): Promise<void> {
    try {
      const res = await ensureDependencies(
        dir,
        Number(process.env.ATEAM_DEP_INSTALL_TIMEOUT_MS ?? 300_000),
      );
      if (res.ran) {
        const tail = res.output.split('\n').slice(-15).join('\n').slice(-1500);
        this.emitEvent(
          agentId,
          'system',
          res.passed
            ? `Installed dependencies before gate: \`${res.command}\``
            : `Dependency install failed before gate: \`${res.command}\``,
          res.passed ? null : tail ? { output: tail } : null,
          workItemId,
        );
      }
    } catch {
      /* best-effort: the downstream gate will surface any real failure */
    }
  }

  /**
   * The integrated epic clone failed to build. Route a high-priority fix task
   * (capped by the shared remediation budget); after MAX_REMEDIATION_ITER rounds,
   * park the epic and ask the user to
   * merge anyway or keep working.
   */
  private async handleIntegratedBuildFailure(
    epic: WorkItem,
    built: { command: string; output: string },
    lead: Agent,
  ): Promise<void> {
    const iter = (this.epicRemediationIter.get(epic.id) ?? 0) + 1;
    this.epicRemediationIter.set(epic.id, iter);
    const tail = built.output.split('\n').slice(-25).join('\n').slice(-2000);
    this.emitEvent(
      lead.id,
      'system',
      `Integrated build FAILED: \`${built.command}\` - blocking merge`,
      tail ? { output: tail } : null,
      epic.id,
    );

    if (iter >= ProjectOrchestrator.MAX_REMEDIATION_ITER) {
      this.awaitingInput.add(epic.id);
      this.notify(
        'question',
        `Integrated build blocked: ${epic.title}`,
        `The integrated build (\`${built.command}\`) still fails after ${iter} rounds.`,
        'board',
        epic.id,
        lead.id,
      );
      void this.raiseQuestion(
        lead.id,
        `Epic "${epic.title}" still fails its integrated build (\`${built.command}\`) after ${iter} ` +
          `rounds. Merge anyway, or keep working on it?`,
        ['Keep working', 'Merge anyway'],
      ).then((ans) => {
        this.awaitingInput.delete(epic.id);
        if (ans.toLowerCase().startsWith('merge')) {
          this.forcedAccept.add(epic.id);
          this.epicRemediationIter.delete(epic.id);
        } else {
          this.epicRemediationIter.set(epic.id, 0);
          this.createFixTask(
            epic,
            `fix: integrated build failing (${built.command})`,
            `The integrated epic build \`${built.command}\` is failing. Diagnose and fix so it ` +
              `passes:\n\n${tail}`,
            lead,
          );
        }
        this.pokeLead();
      });
      return;
    }

    this.createFixTask(
      epic,
      `fix: integrated build failing (${built.command})`,
      `The integrated epic build \`${built.command}\` is failing. Diagnose and fix so it passes:\n\n${tail}`,
      lead,
    );
    this.pokeLead();
  }

  /**
   * MAJOR-1: have a verifier (QA > architect > Lead) author a spec-derived
   * acceptance probe at `.ateam/acceptance.mjs` in the epic clone, committed to the
   * epic branch so it is present when the epic gate runs at finalize. The probe is
   * derived from the REQUEST/contract (endpoints, response shapes, status codes,
   * behavior), NOT the implementation, so it is independent of the builders' own
   * unit tests. Entirely best-effort: skipped when an explicit `acceptanceCommand`
   * override exists, when there is no epic worktree, or on any error - it must never
   * block dispatch.
   */
  private async authorAcceptanceProbe(
    epic: WorkItem,
    content: string,
    thread: { id: string },
  ): Promise<void> {
    if (this.project().settings.acceptanceCommand?.trim()) return;
    const wt = this.epicWorktrees.get(epic.id);
    if (!wt) return;
    const author =
      this.findAgentByStream('qa') ??
      this.specialists().find((s) => s.name === 'architect') ??
      this.lead();
    try {
      await this.actor(author).ask(
        `Author an executable ACCEPTANCE PROBE for epic "${epic.title}" at the path ` +
          `\`.ateam/acceptance.mjs\` in this repository. It is a spec-derived, black-box ` +
          `contract check that the team's delivery will be gated against before merge.\n\n` +
          `Request (source of truth for the contract):\n${content.slice(0, 2000)}\n\n` +
          `Requirements for the probe:\n` +
          `- A standalone Node script (\`node .ateam/acceptance.mjs\`) using ONLY Node built-ins ` +
          `(node:test/node:assert/node:http/child_process are fine); it must NOT add dependencies.\n` +
          `- Assert the EXTERNAL, observable contract from the request: required endpoints/commands, ` +
          `request/response shapes, status codes, and key behaviors - NOT internal implementation ` +
          `details, and NOT a copy of the builders' unit tests.\n` +
          `- Boot or import the delivered system itself (start the server / spawn the CLI / import ` +
          `the public entry point) and exercise it end-to-end. Fail fast with a clear message.\n` +
          `- Be CROSS-PLATFORM (this gate also runs on Windows): to launch the app, prefer spawning ` +
          `\`node <entryFile>\` directly (discover the entry from package.json "main"/"bin" or a ` +
          `\`server.js\`/\`index.js\`), NOT \`npm start\`. If you must spawn \`npm\`/a \`.cmd\`, pass ` +
          `\`{ shell: true }\` to child_process.spawn - otherwise Windows throws \`spawn EINVAL\`.\n` +
          `- Exit 0 when every contract assertion passes; exit non-zero otherwise.\n` +
          `- Be resilient to the exact file layout (discover the entry point) so it runs against the ` +
          `integrated tree.\n\n` +
          `Write ONLY that one file. Do not implement the product, create tasks, or ask questions.`,
        thread.id,
        epic.id,
        wt.path,
      );
      const probePath = path.join(wt.path, '.ateam', 'acceptance.mjs');
      if (fs.existsSync(probePath)) {
        await this.deps.git.commitWork(
          wt.path,
          `test: add spec-derived acceptance probe for ${epic.title}`,
        );
        this.emitEvent(
          author.id,
          'system',
          `Authored acceptance probe \`.ateam/acceptance.mjs\` (spec-derived contract gate)`,
          null,
          epic.id,
        );
      }
    } catch {
      /* probe authoring is best-effort */
    }
  }

  /**
   * The deterministic ACCEPTANCE PROBE (MAJOR-1) failed against the integrated
   * tree: the delivery does not satisfy the spec-derived contract, even though the
   * builders' own tests/gates passed. Route it back as fix work (capped by the
   * shared remediation budget); after MAX_REMEDIATION_ITER rounds, park the epic
   * and ask the user to merge anyway or keep working. Same shape as the integrated
   * build failure, but the fix brief points at the CONTRACT, not a compile error.
   */
  private async handleFailedAcceptanceProbe(
    epic: WorkItem,
    probe: { command: string; output: string },
    lead: Agent,
  ): Promise<void> {
    const iter = (this.epicRemediationIter.get(epic.id) ?? 0) + 1;
    this.epicRemediationIter.set(epic.id, iter);
    const tail = probe.output.split('\n').slice(-25).join('\n').slice(-2000);
    this.emitEvent(
      lead.id,
      'system',
      `Acceptance probe FAILED: \`${probe.command}\` - delivery does not meet the spec contract, blocking merge`,
      tail ? { output: tail } : null,
      epic.id,
    );
    const fixBrief = (): void => {
      this.createFixTask(
        epic,
        `fix: acceptance probe failing (${probe.command})`,
        `The deterministic acceptance probe \`${probe.command}\` is FAILING against the ` +
          `integrated build. This is a spec-derived contract check that is independent of the ` +
          `unit tests, so the delivery deviates from the REQUIRED external contract (endpoints, ` +
          `response shapes, status codes, or behavior). Diagnose from the probe output and fix ` +
          `the IMPLEMENTATION to satisfy the contract - do NOT weaken or edit the probe:\n\n${tail}`,
        lead,
      );
    };

    if (iter >= ProjectOrchestrator.MAX_REMEDIATION_ITER) {
      this.awaitingInput.add(epic.id);
      this.notify(
        'question',
        `Acceptance probe blocked: ${epic.title}`,
        `The acceptance probe (\`${probe.command}\`) still fails after ${iter} rounds.`,
        'board',
        epic.id,
        lead.id,
      );
      void this.raiseQuestion(
        lead.id,
        `Epic "${epic.title}" still fails its acceptance probe (\`${probe.command}\`) after ${iter} ` +
          `rounds - the delivery does not meet the spec contract. Merge anyway, or keep working on it?`,
        ['Keep working', 'Merge anyway'],
      ).then((ans) => {
        this.awaitingInput.delete(epic.id);
        if (ans.toLowerCase().startsWith('merge')) {
          this.forcedAccept.add(epic.id);
          this.epicRemediationIter.delete(epic.id);
        } else {
          this.epicRemediationIter.set(epic.id, 0);
          fixBrief();
        }
        this.pokeLead();
      });
      return;
    }

    fixBrief();
    this.pokeLead();
  }

  /**
   * Ask a judge (QA specialist > reviewer > Lead) to rule on each acceptance
   * criterion against the diff, persist the verdicts, and return whether the
   * epic passes. An explicit FAILED is the only thing that gates; an
   * unmentioned criterion or an infrastructure error is treated as pass so a
   * flaky judge turn can't deadlock delivery.
   */
  private async evaluateAcceptance(
    epic: WorkItem,
    criteria: AcceptanceCriterion[],
    wt: { branch: string; path: string } | undefined,
    diff: string,
  ): Promise<{ ok: true } | { ok: false; unmet: AcceptanceCriterion[] }> {
    const judge = this.findAgentByStream('qa') ?? this.findReviewer(this.lead());
    const thread = this.threadForWorkItem(epic);
    const numbered = criteria.map((c, i) => `${i + 1}. ${c.text}`).join('\n');
    // COMPLETE file list (cheap, .ateam-excluded) so the judge can never falsely
    // rule a whole subsystem "not delivered" just because the textual diff was
    // truncated before it. The content diff below is best-effort context only.
    let fileStat = '';
    if (wt) {
      try {
        const base = await this.deps.git.currentBranch(this.project().repoDir);
        fileStat = await this.deps.git.branchFileStat(wt.path, base);
      } catch {
        /* ignore */
      }
    }
    const prompt =
      `Judge each acceptance criterion for epic "${epic.title}" against the delivered work.\n\n` +
      `ORIGINAL REQUEST (source of truth):\n${(epic.description ?? '').slice(0, 2000)}\n\n` +
      `Acceptance criteria:\n${numbered}\n\n` +
      (fileStat
        ? `Files delivered (COMPLETE list - trust THIS over the diff for "was X built?"; ` +
          `the diff below may be truncated, this list is not):\n${fileStat}\n\n`
        : '') +
      `Diff (may be truncated):\n${diff.slice(0, 6000) || '(no textual diff)'}\n\n` +
      `You are running INSIDE the delivered working tree. The content diff may be cut ` +
      `off, so NEVER mark a criterion FAILED as "not delivered"/"missing" from the diff ` +
      `alone - first OPEN the relevant files (they are in your working directory; use ` +
      `view/grep) and confirm the code is genuinely absent or wrong. `
      +
      `Reply with ONE line per criterion in the exact form "AC<n>: MET" or ` +
      `"AC<n>: FAILED - <short reason>". Judge whether the code ACTUALLY satisfies ` +
      `the criterion, not whether it was intended. A criterion that encodes a HARD ` +
      `CONSTRAINT from the request (in-memory storage, "no external dependencies", ` +
      `language/runtime, required endpoints) must be FAILED if the delivery deviates - ` +
      `even if the feature otherwise works. Do not write code here.`;
    let verdictText = '';
    try {
      verdictText = (await this.actor(judge).ask(prompt, thread.id, epic.id, wt?.path)) ?? '';
    } catch {
      return { ok: true };
    }
    const verdicts = parseVerdicts(verdictText, criteria.length);
    const unmet: AcceptanceCriterion[] = [];
    criteria.forEach((c, i) => {
      const met = verdicts.get(i + 1);
      const status: CriterionStatus = met === false ? 'failed' : 'met';
      this.deps.store.setCriterionStatus(c.id, status);
      if (status === 'failed') unmet.push({ ...c, status });
    });
    const refreshed = this.deps.store.listCriteria(epic.id);
    this.deps.bus.publish({
      type: 'criteria.updated',
      projectId: this.projectId,
      epicId: epic.id,
      criteria: refreshed,
    });
    this.emitEvent(
      judge.id,
      'system',
      unmet.length === 0
        ? `Acceptance check passed: ${criteria.length}/${criteria.length} criteria met`
        : `Acceptance check: ${criteria.length - unmet.length}/${criteria.length} met, ${unmet.length} unmet`,
      unmet.length ? { unmet: unmet.map((c) => c.text) } : null,
      epic.id,
    );
    return unmet.length === 0 ? { ok: true } : { ok: false, unmet };
  }

  /**
   * Route unmet acceptance criteria back as a high-priority fix task. After
   * MAX_REMEDIATION_ITER rounds (shared with the build gate), stop looping and
   * ask the user to merge anyway or
   * keep working (parking the epic so review doesn't re-trigger meanwhile).
   */
  private async handleUnmetCriteria(
    epic: WorkItem,
    unmet: AcceptanceCriterion[],
    lead: Agent,
  ): Promise<void> {
    const iter = (this.epicRemediationIter.get(epic.id) ?? 0) + 1;
    this.epicRemediationIter.set(epic.id, iter);
    const list = unmet.map((c) => `- ${c.text}`).join('\n');

    if (iter >= ProjectOrchestrator.MAX_REMEDIATION_ITER) {
      this.awaitingInput.add(epic.id);
      this.notify(
        'question',
        `Acceptance blocked: ${epic.title}`,
        `${unmet.length} acceptance criteria are still unmet after ${iter} rounds.`,
        'board',
        epic.id,
        lead.id,
      );
      void this.raiseQuestion(
        lead.id,
        `Epic "${epic.title}" still has ${unmet.length} unmet acceptance criteria after ${iter} rounds:\n` +
          `${list}\n\nMerge anyway, or keep working on them?`,
        ['Keep working', 'Merge anyway'],
      ).then((ans) => {
        this.awaitingInput.delete(epic.id);
        if (ans.toLowerCase().startsWith('merge')) {
          // Force the merge; leave the criteria marked failed for the record.
          this.forcedAccept.add(epic.id);
          this.epicRemediationIter.delete(epic.id);
        } else {
          this.epicRemediationIter.set(epic.id, 0);
          this.createAcceptanceFix(epic, unmet, lead);
        }
        this.pokeLead();
      });
      return;
    }

    this.createAcceptanceFix(epic, unmet, lead);
    this.pokeLead();
  }

  /** Open a high-priority fix task for the unmet criteria and assign it. */
  private createAcceptanceFix(epic: WorkItem, unmet: AcceptanceCriterion[], lead: Agent): void {
    const body = unmet.map((c) => `- ${c.text}`).join('\n');
    this.createFixTask(
      epic,
      `fix: unmet acceptance criteria (${unmet.length})`,
      `These acceptance criteria are not yet met for "${epic.title}". Implement and verify them so ` +
        `each holds:\n\n${body}`,
      lead,
    );
  }

  /** Open a high-priority fix task under an epic and assign it to a builder. */
  private createFixTask(epic: WorkItem, title: string, description: string, lead: Agent): void {
    const target = this.pickAgentForItem(
      { stream: null } as WorkItem,
      this.scopedSpecialists(epic),
    );
    const fix = this.deps.store.createWorkItem({
      projectId: this.projectId,
      kind: 'task',
      parentId: epic.id,
      title,
      description,
      status: 'todo',
      priority: 'high',
      assigneeAgentId: target?.id ?? null,
      stream: target?.name ?? null,
    });
    this.deps.bus.publish({ type: 'workitem.updated', projectId: this.projectId, workItem: fix });
    this.emitEvent(lead.id, 'system', `Opened fix "${fix.title}"`, null, fix.id);
    if (target) void this.onItemAssigned(fix.id).catch(() => undefined);
    else this.pokeLead();
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
    this.emitEvent(approver.id, 'pull_request', `Approved PR for "${epic.title}"`, null, epic.id);

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
    this.finalizeEpicMetrics(epic);
    this.emitEvent(
      this.lead().id,
      'system',
      `Epic "${epic.title}" merged and closed`,
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
      delegate: async (input) => {
        const task = String(input.task ?? '').trim();
        if (!task) return { ok: false, error: 'No task described to delegate.' };
        const spec = this.pickSpecialist(input.specialist ?? null);
        if (!spec) {
          return { ok: false, error: 'No specialist is available to take this on.' };
        }
        const threadId = this.ensureMainThread().id;
        this.emitEvent(
          agent.id,
          'system',
          `Delegated to ${spec.displayName}: ${task.slice(0, 80)}`,
          null,
          null,
        );
        const prompt =
          `The Team Lead has delegated an AD-HOC task to you. Do it and report back concisely.\n\n` +
          `TASK:\n${task}\n\n` +
          (input.context ? `CONTEXT:\n${String(input.context)}\n\n` : '') +
          `Guidance:\n` +
          `- This is a one-off request, NOT a tracked deliverable. Investigate, verify, run, inspect, ` +
          `or answer as needed and REPORT what you found — with concrete evidence (commands, output, ` +
          `status codes, file/line refs).\n` +
          `- To check a running app, use the \`probe_app\` tool (it boots in the background, probes, and ` +
          `tears down) — never run a blocking start command (\`npm start\`, \`node server.js\`) directly.\n` +
          `- Do NOT change deliverables or commit code here. If this actually requires editing/fixing ` +
          `the codebase, do NOT do it — say so and recommend the Lead open a proper task so it goes ` +
          `through the normal review + acceptance flow.\n` +
          `- Finish with a clear, concise report of what you did and what you found.`;
        try {
          const report = await this.actor(spec).ask(prompt, threadId, null, this.project().repoDir);
          return { ok: true, specialist: spec.displayName, report };
        } catch (err) {
          return { ok: false, specialist: spec.displayName, error: String(err) };
        }
      },
    };
  }

  /**
   * Pick a specialist to run an ad-hoc delegated task. Prefers an explicitly named
   * stream/name; otherwise prefers a shell-capable specialist (most ad-hoc asks need
   * to run something), favouring QA then a backend/server role, and only falls back
   * to a read-only specialist when no shell-capable one exists. Null when the project
   * has no specialists at all.
   */
  private pickSpecialist(preferred: string | null): Agent | null {
    const specialists = this.specialists();
    if (specialists.length === 0) return null;
    const pref = preferred?.trim().toLowerCase();
    if (pref) {
      const m = specialists.find((s) => s.name.toLowerCase() === pref);
      if (m) return m;
    }
    const shellable = specialists.filter((s) => s.tools === null || s.tools.includes('bash'));
    const pool = shellable.length ? shellable : specialists;
    return (
      pool.find((s) => /qa|test/.test(s.name.toLowerCase())) ??
      pool.find((s) => /back|api|server|engineer/.test(s.name.toLowerCase())) ??
      pool[0] ??
      null
    );
  }

  private moveItem(workItemId: string, status: WorkItem['status']): void {
    const updated = this.deps.store.updateWorkItem(workItemId, { status });
    if (updated) {
      this.lastBoardActivityAt = Date.now();
      this.deps.bus.publish({
        type: 'workitem.updated',
        projectId: this.projectId,
        workItem: updated,
      });
    }
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
    // The Team Lead orchestrates and reviews - it must NEVER modify files or run
    // mutating shell itself. All code is produced by specialists in their epic
    // clones; the Lead's edits would land in the main checkout, orphaned. Reads
    // are fine (it may inspect the repo to plan).
    if (agent?.kind === 'lead' && ask.kind !== 'read') return 'reject';
    if (project.settings.approvalMode === 'auto-workspace') {
      if (ask.kind === 'read') return 'approve';
      // Writes/shell are allowed inside the project checkout OR inside a managed
      // epic clone (under the worktree root) - specialists work in their clone,
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
    // A specialist's question goes to the Team Lead first - the Lead owns the
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
   * - in which case we surface that question and relay the human's answer back to
   * the specialist. Everything is posted to main chat so ownership stays visible.
   */
  private async resolveViaLead(agent: Agent, ask: UserInputAsk): Promise<string> {
    const lead = this.lead();
    const main = this.ensureMainThread();
    const choicesTxt = ask.choices?.length ? `\nOptions: ${ask.choices.join(' | ')}` : '';
    this.emitEvent(agent.id, 'escalation', `Asked the Team Lead: ${ask.question}`, null, null);
    const prompt =
      `${agent.displayName} is blocked and needs a decision to continue:\n\n` +
      `"${ask.question}"${choicesTxt}\n\n` +
      `As Team Lead you own delivery and the user relationship. Resolve this so the work ` +
      `can proceed. If you can decide from the product/technical direction, reply with a ` +
      `clear, actionable answer addressed to ${agent.displayName} (name the option to take if ` +
      `there are choices). Only if this genuinely requires the human user's decision, reply ` +
      `with exactly "ESCALATE: <the specific question to ask the user>". Keep it concise.`;
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
    trackNoCodeItemId?: string,
  ): Promise<string> {
    const q = this.deps.store.createQuestion({
      projectId: this.projectId,
      agentId,
      question,
      choices: choices ?? null,
    });
    // Register no-code blockers so an @mention take-over can find (and only find)
    // these questions - it must never sweep build/integration/epic-review prompts.
    if (trackNoCodeItemId) this.noCodeQuestions.set(trackNoCodeItemId, q.id);
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

/**
 * Extract structured acceptance criteria from the PM's free-form reply: every
 * line prefixed with `AC:` (optionally after a bullet). Bounded in count and
 * length so a runaway reply can't bloat the store.
 */
function parseCriteria(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const m = /^\s*(?:[-*]\s*)?AC:\s*(.+?)\s*$/i.exec(raw);
    if (m && m[1]) out.push(m[1].slice(0, 300));
    if (out.length >= 12) break;
  }
  return out;
}

/**
 * Parse a judge's acceptance verdict block: lines like `AC1: MET` or
 * `AC2: FAILED - reason`. Returns a map of 1-based criterion index -> met.
 * Out-of-range indices are ignored.
 */
function parseVerdicts(text: string, count: number): Map<number, boolean> {
  const out = new Map<number, boolean>();
  for (const raw of text.split('\n')) {
    const m = /^\s*AC\s*(\d+)\s*[:-]\s*(MET|FAILED)\b/i.exec(raw);
    if (!m) continue;
    const n = Number(m[1]);
    if (n >= 1 && n <= count) out.set(n, /^met$/i.test(m[2]!));
  }
  return out;
}

/** A concise, board-friendly goal phrase from a free-form user request. */
function shortGoal(content: string): string {
  // Prefer the first line that actually describes the work. When a whole spec is
  // pasted, the first line is often a heading like "# Epic 2" or a section title
  // like "1. Summary / goal" - strip markdown lead-ins and skip bare section
  // headers so the epic/task titles read like real goals.
  const sectionHeader =
    /^(summary|goals?|overview|requirements?|scope|objective|context|background|description)\b/i;
  const lines = content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  let pick = '';
  for (const raw of lines) {
    const cleaned = raw
      .replace(/^#{1,6}\s*/, '') // markdown heading
      .replace(/^>\s*/, '') // blockquote
      .replace(/^[-*+]\s+/, '') // bullet
      .replace(/^\d+[.)]\s*/, '') // numbered list
      .replace(/^epic\s*\d*\s*[\u2014:-]\s*/i, '') // "Epic 2 - " / "Epic:" prefix
      .replace(/^\s*(please|can you|could you|hey|hi)[,\s]+/i, '')
      .replace(/[.?!]+\s*$/, '')
      .replace(/[*_`#]/g, '')
      .trim();
    if (!cleaned) continue;
    if (sectionHeader.test(cleaned) && cleaned.length < 40) continue; // section header, keep looking
    pick = cleaned;
    break;
  }
  if (!pick) pick = (lines[0] ?? content).replace(/^#{1,6}\s*/, '').trim();
  return (pick.length > 70 ? `${pick.slice(0, 67)}...` : pick) || 'the requested work';
}

/** Epic title from a request - capitalized short goal. */
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
