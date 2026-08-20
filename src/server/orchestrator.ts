import path from 'node:path';
import { nanoid } from 'nanoid';
import type { Agent, Project, WorkItem } from '@shared/index';
import type { Store } from './db/store.js';
import type { Bus } from './bus.js';
import type {
  AdapterEvent,
  AgentDef,
  CopilotAdapter,
  PermissionAsk,
  TeamSession,
  UserInputAsk,
} from './agents/adapter.js';
import { TEAM_LEAD_PROMPT } from './agents/catalog.js';
import { discoverSkills, skillDirectories } from './agents/skillScanner.js';

interface Deps {
  store: Store;
  bus: Bus;
  adapter: CopilotAdapter;
  skillHomeRoots: string[];
}

/** Is `filePath` inside `repoDir`? Used for workspace-scoped auto-approval. */
function isInsideWorkspace(repoDir: string, filePath: string | undefined): boolean {
  if (!filePath) return true; // nothing concrete to gate
  const root = path.resolve(repoDir);
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath);
  const rel = path.relative(root, abs);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Runs one project's team: owns the Team Lead session, translates adapter events
 * into persisted state + WebSocket broadcasts, and implements delegation, the
 * autonomous pull-loop, escalations, and permission handling.
 */
class ProjectOrchestrator {
  private session: TeamSession | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private currentWorkItemId: string | null = null;
  private readonly pending = new Map<string, (answer: string) => void>();

  constructor(
    private readonly projectId: string,
    private readonly deps: Deps,
  ) {}

  private project(): Project {
    const p = this.deps.store.getProject(this.projectId);
    if (!p) throw new Error(`project ${this.projectId} not found`);
    return p;
  }

  private agentIdByName(name: string | null): string | null {
    if (!name) return null;
    return this.deps.store.getAgentByName(this.projectId, name)?.id ?? null;
  }

  /** Build (or reuse) the Team Lead session from the project's current team. */
  private async ensureSession(): Promise<TeamSession> {
    if (this.session) return this.session;
    const project = this.project();
    const agents = this.deps.store.listAgents(this.projectId);
    const lead = agents.find((a) => a.kind === 'lead');
    const specialists = agents.filter((a) => a.kind === 'specialist');

    const skills = discoverSkills(
      this.deps.skillHomeRoots,
      project.repoDir,
      project.settings.extraSkillRoots,
    );
    const dirs = skillDirectories(skills);

    const defs: AgentDef[] = specialists.map((s) => ({
      name: s.name,
      displayName: s.displayName,
      description: s.description,
      prompt: s.prompt,
      tools: s.tools,
      skills: s.skills,
      model: s.model,
    }));

    this.session = await this.deps.adapter.createTeamSession({
      projectId: this.projectId,
      workingDirectory: project.repoDir,
      leadName: lead?.name ?? 'team-lead',
      leadDisplayName: lead?.displayName ?? 'Team Lead',
      leadModel: lead?.model ?? project.settings.defaultModel,
      leadPrompt: lead?.prompt ?? TEAM_LEAD_PROMPT,
      specialists: defs,
      skillDirectories: dirs,
      approvalMode: project.settings.approvalMode,
      onEvent: (event) => this.handleEvent(event),
      onPermission: (ask) => this.handlePermission(ask),
      onUserInput: (ask) => this.handleUserInput(ask),
    });
    return this.session;
  }

  /** Rebuild the session next time (e.g. after the team roster changes). */
  async invalidateSession(): Promise<void> {
    const old = this.session;
    this.session = null;
    if (old) await old.dispose().catch(() => undefined);
  }

  /* --------------------------------------------------------------- actions */

  /** Handle a chat message from the user to the Team Lead. */
  chat(content: string): Promise<void> {
    return this.enqueue(async () => {
      const user = this.deps.store.appendChat({ projectId: this.projectId, role: 'user', content });
      this.deps.bus.publish({ type: 'chat.message', projectId: this.projectId, message: user });
      this.deps.store.appendEvent({
        projectId: this.projectId,
        type: 'message',
        summary: `User: ${content}`,
      });

      const session = await this.ensureSession();
      const placeholder = this.deps.store.appendChat({
        projectId: this.projectId,
        role: 'lead',
        content: '',
      });
      this.deps.bus.publish({
        type: 'chat.message',
        projectId: this.projectId,
        message: placeholder,
      });

      this.leadMessageId = placeholder.id;
      this.leadBuffer = '';
      await session.send(this.buildChatPrompt(content), placeholder.id);
      await this.pullNextForAll();
    });
  }

  /** Dispatch a specific work item to its assigned agent (delegation). */
  dispatchWorkItem(workItemId: string): Promise<void> {
    return this.enqueue(() => this.runWorkItem(workItemId));
  }

  private async runWorkItem(workItemId: string): Promise<void> {
    const item = this.deps.store.getWorkItem(workItemId);
    if (!item || !item.assigneeAgentId) return;
    const agent = this.deps.store.getAgent(item.assigneeAgentId);
    if (!agent || agent.kind !== 'specialist') return;
    if (item.status === 'done' || item.status === 'in_progress') return;

    this.currentWorkItemId = item.id;
    this.moveItem(item.id, 'in_progress');
    this.setStatus(agent.id, 'working');
    this.deps.store.upsertTask({
      projectId: this.projectId,
      agentId: agent.id,
      workItemId: item.id,
      title: item.title,
      status: 'doing',
    });
    this.deps.bus.publish({
      type: 'task.updated',
      projectId: this.projectId,
      task: this.deps.store.listTasks(this.projectId, agent.id).slice(-1)[0]!,
    });

    const session = await this.ensureSession();
    const placeholder = this.deps.store.appendChat({
      projectId: this.projectId,
      role: 'lead',
      content: '',
    });
    this.deps.bus.publish({
      type: 'chat.message',
      projectId: this.projectId,
      message: placeholder,
    });
    this.leadMessageId = placeholder.id;
    this.leadBuffer = '';

    await session.send(this.buildDispatchPrompt(agent, item), placeholder.id);

    // On completion, move to review and mark agent idle, then pull the next item.
    const latest = this.deps.store.getWorkItem(item.id);
    if (latest && latest.status === 'in_progress') this.moveItem(item.id, 'review');
    this.setStatus(agent.id, 'idle');
    this.deps.store.upsertTask({
      projectId: this.projectId,
      agentId: agent.id,
      workItemId: item.id,
      title: item.title,
      status: 'done',
    });
    this.currentWorkItemId = null;
    await this.pullNext(agent.id);
  }

  /** Autonomous pull-loop: an idle agent picks up its next assigned item. */
  private async pullNext(agentId: string): Promise<void> {
    const next = this.deps.store.nextAssignedItem(this.projectId, agentId);
    if (next) await this.runWorkItem(next.id);
  }

  private async pullNextForAll(): Promise<void> {
    for (const agent of this.deps.store.listAgents(this.projectId)) {
      if (agent.kind !== 'specialist' || agent.status === 'working') continue;
      const next = this.deps.store.nextAssignedItem(this.projectId, agent.id);
      if (next) {
        await this.runWorkItem(next.id);
        return; // one at a time per project turn; loop continues on next idle
      }
    }
  }

  /** Public entry used when an item is (re)assigned via the API. */
  onItemAssigned(workItemId: string): Promise<void> {
    return this.enqueue(async () => {
      const item = this.deps.store.getWorkItem(workItemId);
      if (item && item.assigneeAgentId && (item.status === 'backlog' || item.status === 'todo')) {
        await this.runWorkItem(workItemId);
      }
    });
  }

  answer(questionId: string, answer: string): boolean {
    const resolve = this.pending.get(questionId);
    if (!resolve) return false;
    this.pending.delete(questionId);
    resolve(answer);
    return true;
  }

  /* --------------------------------------------------------------- helpers */

  private leadMessageId: string | null = null;
  private leadBuffer = '';

  private buildChatPrompt(content: string): string {
    const specialists = this.deps.store
      .listAgents(this.projectId)
      .filter((a) => a.kind === 'specialist');
    const roster = specialists
      .map((s) => `- \`${s.name}\` — ${s.displayName}: ${s.description}`)
      .join('\n');
    return (
      `${content}\n\n---\nYour available specialist agents:\n${roster || '(none yet)'}\n` +
      `If this requires hands-on work, delegate to the most suitable specialist by referencing its name in backticks, e.g. delegate to \`frontend\`.`
    );
  }

  private buildDispatchPrompt(agent: Agent, item: WorkItem): string {
    return (
      `A work item has been assigned to the specialist \`${agent.name}\` (${agent.displayName}). ` +
      `Delegate it to that agent and have them complete it.\n\n` +
      `Work item: ${item.title}\n` +
      `Details: ${item.description || '(none provided)'}\n\n` +
      `Coordinate, then give me a short summary when done.`
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

  private setStatus(agentId: string, status: Agent['status']): void {
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

  private handleEvent(event: AdapterEvent): void {
    try {
      this.handleEventUnsafe(event);
    } catch (err) {
      process.stderr.write(
        `[orchestrator ${this.projectId}] event handler error: ${err instanceof Error ? err.stack : String(err)}\n`,
      );
    }
  }

  private handleEventUnsafe(event: AdapterEvent): void {
    const { store, bus } = this.deps;
    const pid = this.projectId;
    switch (event.kind) {
      case 'lead_delta':
        this.leadBuffer += event.delta;
        bus.publish({
          type: 'chat.delta',
          projectId: pid,
          messageId: event.messageId,
          delta: event.delta,
        });
        break;
      case 'lead_message': {
        const updated = store.updateChat(event.messageId, event.text);
        if (updated) bus.publish({ type: 'chat.message', projectId: pid, message: updated });
        store.appendEvent({
          projectId: pid,
          type: 'message',
          summary: `Team Lead: ${event.text.slice(0, 200)}`,
        });
        break;
      }
      case 'reasoning':
        this.emitAgentEvent(
          event.agentName,
          'reasoning',
          event.text,
          { text: event.text },
          this.currentWorkItemId,
        );
        break;
      case 'tool_call':
        this.emitAgentEvent(
          event.agentName,
          'tool_call',
          `${event.toolName}`,
          event.detail ?? null,
          this.currentWorkItemId,
        );
        break;
      case 'tool_result':
        this.emitAgentEvent(
          event.agentName,
          'tool_result',
          `${event.toolName} done`,
          event.detail ?? null,
          this.currentWorkItemId,
        );
        break;
      case 'subagent_started': {
        const agentId = this.agentIdByName(event.agentName);
        if (agentId) this.setStatus(agentId, 'working');
        this.emitAgentEvent(
          event.agentName,
          'subagent_started',
          `${event.displayName} started`,
          { description: event.description },
          this.currentWorkItemId,
        );
        break;
      }
      case 'subagent_completed': {
        const agentId = this.agentIdByName(event.agentName);
        if (agentId) this.setStatus(agentId, 'idle');
        this.emitAgentEvent(
          event.agentName,
          'subagent_completed',
          `${event.displayName} completed`,
          event.detail ?? null,
          this.currentWorkItemId,
        );
        break;
      }
      case 'subagent_failed': {
        const agentId = this.agentIdByName(event.agentName);
        if (agentId) this.setStatus(agentId, 'blocked');
        this.emitAgentEvent(
          event.agentName,
          'subagent_failed',
          `${event.displayName} failed: ${event.error}`,
          { error: event.error },
          this.currentWorkItemId,
        );
        break;
      }
      case 'task_update': {
        const agentId = this.agentIdByName(event.agentName);
        if (agentId) {
          const task = store.upsertTask({
            projectId: pid,
            agentId,
            workItemId: this.currentWorkItemId,
            title: event.title,
            status: event.status,
          });
          bus.publish({ type: 'task.updated', projectId: pid, task });
        }
        break;
      }
      case 'idle':
        break;
    }
  }

  private emitAgentEvent(
    agentName: string | null,
    type: Parameters<Store['appendEvent']>[0]['type'],
    summary: string,
    detail: Record<string, unknown> | null,
    workItemId: string | null,
  ): void {
    const agentId = this.agentIdByName(agentName);
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

  private async handlePermission(ask: PermissionAsk): Promise<'approve' | 'reject'> {
    const project = this.project();
    if (project.settings.approvalMode === 'auto-workspace') {
      if (ask.kind === 'read') return 'approve';
      const ok = isInsideWorkspace(project.repoDir, ask.fileName);
      return ok ? 'approve' : 'reject';
    }
    // manual: surface as a yes/no question to the user.
    const label =
      ask.kind === 'shell'
        ? `run command: ${ask.command ?? ''}`
        : ask.fileName
          ? `${ask.kind} ${ask.fileName}`
          : `use ${ask.toolName ?? ask.kind}`;
    const answer = await this.raiseQuestion(
      this.agentIdByName(ask.agentName),
      `Approve ${label}?`,
      ['Approve', 'Reject'],
    );
    return answer.toLowerCase().startsWith('a') ? 'approve' : 'reject';
  }

  private async handleUserInput(ask: UserInputAsk): Promise<string> {
    const agentId = this.agentIdByName(ask.agentName);
    if (agentId) this.setStatus(agentId, 'needs_input');
    const answer = await this.raiseQuestion(agentId, ask.question, ask.choices);
    if (agentId) this.setStatus(agentId, 'working');
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

  /** Serialize all turns for this project so streams never interleave. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run as Promise<T>;
  }

  async dispose(): Promise<void> {
    if (this.session) await this.session.dispose().catch(() => undefined);
    this.session = null;
  }
}

/** Owns one orchestrator per project; enables many projects to run in parallel. */
export class OrchestratorManager {
  private readonly byProject = new Map<string, ProjectOrchestrator>();
  private readonly _id = nanoid(6);

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
  }

  answer(projectId: string, questionId: string, answer: string): boolean {
    return this.byProject.get(projectId)?.answer(questionId, answer) ?? false;
  }

  async shutdown(): Promise<void> {
    for (const o of this.byProject.values()) await o.dispose();
    this.byProject.clear();
    await this.deps.adapter.shutdown();
  }
}

export type { ProjectOrchestrator };
