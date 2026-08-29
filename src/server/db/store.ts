import { nanoid } from 'nanoid';
import type { DB } from './database.js';
import type {
  Agent,
  AgentEvent,
  AgentEventType,
  AgentStatus,
  AgentNote,
  AgentTask,
  AgentTaskStatus,
  ChatMessage,
  ChatRole,
  GitCommit,
  GitFileChange,
  Project,
  ProjectSettings,
  PullRequest,
  PrStatus,
  PrComment,
  AcceptanceCriterion,
  VerificationReportRecord,
  VerificationCheck,
  EpicMetrics,
  Question,
  Notification,
  NotificationType,
  Thread,
  ThreadKind,
  UsageEntry,
  WorkItem,
} from '@shared/index';

const now = (): string => new Date().toISOString();
const id = (prefix: string): string => `${prefix}_${nanoid(12)}`;

/* ------------------------------------------------------------------ mappers */

interface ProjectRow {
  id: string;
  name: string;
  repo_dir: string;
  settings: string;
  created_at: string;
  updated_at: string;
}
const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  name: r.name,
  repoDir: r.repo_dir,
  settings: JSON.parse(r.settings) as ProjectSettings,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

interface AgentRow {
  id: string;
  project_id: string;
  kind: string;
  name: string;
  display_name: string;
  description: string;
  prompt: string;
  tools: string | null;
  skills: string;
  model: string;
  emoji: string;
  color: string;
  catalog_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}
const toAgent = (r: AgentRow): Agent => ({
  id: r.id,
  projectId: r.project_id,
  kind: r.kind as Agent['kind'],
  name: r.name,
  displayName: r.display_name,
  description: r.description,
  prompt: r.prompt,
  tools: r.tools ? (JSON.parse(r.tools) as string[]) : null,
  skills: JSON.parse(r.skills) as string[],
  model: r.model,
  emoji: r.emoji,
  color: r.color,
  catalogId: r.catalog_id,
  status: r.status as AgentStatus,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

interface WorkItemRow {
  id: string;
  project_id: string;
  kind: string;
  parent_id: string | null;
  title: string;
  description: string;
  status: string;
  priority: string;
  stream: string | null;
  depends_on: string;
  assignee_agent_id: string | null;
  branch: string | null;
  scheduled_at: number | null;
  recurrence: string;
  progress: number;
  ord: number;
  created_at: string;
  updated_at: string;
}
const toWorkItem = (r: WorkItemRow): WorkItem => ({
  id: r.id,
  projectId: r.project_id,
  kind: (r.kind as WorkItem['kind']) ?? 'task',
  parentId: r.parent_id ?? null,
  title: r.title,
  description: r.description,
  status: r.status as WorkItem['status'],
  priority: r.priority as WorkItem['priority'],
  stream: r.stream ?? null,
  dependsOn: r.depends_on ? (JSON.parse(r.depends_on) as string[]) : [],
  assigneeAgentId: r.assignee_agent_id,
  branch: r.branch ?? null,
  scheduledAt: r.scheduled_at ?? null,
  recurrence: (r.recurrence as WorkItem['recurrence']) ?? 'none',
  order: r.ord,
  progress: r.progress ?? 0,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

interface UsageRow {
  id: string;
  project_id: string;
  work_item_id: string | null;
  agent_id: string;
  input_tokens: number;
  output_tokens: number;
  time_ms: number;
  turns: number;
  updated_at: string;
}
const toUsage = (r: UsageRow): UsageEntry => ({
  projectId: r.project_id,
  workItemId: r.work_item_id ?? null,
  agentId: r.agent_id,
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  timeMs: r.time_ms,
  turns: r.turns,
  updatedAt: r.updated_at,
});

interface AgentTaskRow {
  id: string;
  project_id: string;
  agent_id: string;
  work_item_id: string | null;
  title: string;
  status: string;
  created_at: string;
  updated_at: string;
}
const toTask = (r: AgentTaskRow): AgentTask => ({
  id: r.id,
  projectId: r.project_id,
  agentId: r.agent_id,
  workItemId: r.work_item_id,
  title: r.title,
  status: r.status as AgentTaskStatus,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

interface AgentNoteRow {
  id: string;
  project_id: string;
  agent_id: string;
  work_item_id: string | null;
  kind: string;
  content: string;
  created_at: string;
  updated_at: string;
}
const toNote = (r: AgentNoteRow): AgentNote => ({
  id: r.id,
  projectId: r.project_id,
  agentId: r.agent_id,
  workItemId: r.work_item_id,
  content: r.content,
  createdAt: r.created_at,
});

interface AgentEventRow {
  id: string;
  project_id: string;
  agent_id: string | null;
  work_item_id: string | null;
  type: string;
  summary: string;
  detail: string | null;
  created_at: string;
}

interface EpicMetricsRow {
  epic_id: string;
  project_id: string;
  task_count: number;
  builder_count: number;
  independent_builders: number;
  max_concurrent: number;
  integration_conflicts: number;
  duration_ms: number;
  created_at: string;
}
const toEvent = (r: AgentEventRow): AgentEvent => ({
  id: r.id,
  projectId: r.project_id,
  agentId: r.agent_id,
  workItemId: r.work_item_id,
  type: r.type as AgentEventType,
  summary: r.summary,
  detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null,
  createdAt: r.created_at,
});

interface ChatRow {
  id: string;
  project_id: string;
  thread_id: string;
  role: string;
  author_agent_id: string | null;
  content: string;
  created_at: string;
}
const toChat = (r: ChatRow): ChatMessage => ({
  id: r.id,
  projectId: r.project_id,
  threadId: r.thread_id,
  role: r.role as ChatRole,
  authorAgentId: r.author_agent_id ?? null,
  content: r.content,
  createdAt: r.created_at,
});

interface ThreadRow {
  id: string;
  project_id: string;
  kind: string;
  topic: string;
  status: string;
  work_item_id: string | null;
  participants: string;
  includes_user: number;
  created_at: string;
  updated_at: string;
}
const toThread = (r: ThreadRow): Thread => ({
  id: r.id,
  projectId: r.project_id,
  kind: r.kind as ThreadKind,
  topic: r.topic,
  status: r.status as Thread['status'],
  workItemId: r.work_item_id ?? null,
  participantAgentIds: r.participants ? (JSON.parse(r.participants) as string[]) : [],
  includesUser: r.includes_user !== 0,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

interface PrRow {
  id: string;
  project_id: string;
  work_item_id: string | null;
  author_agent_id: string | null;
  reviewer_agent_id: string | null;
  title: string;
  description: string;
  branch: string;
  base_branch: string;
  diff: string;
  status: string;
  stats: string;
  created_at: string;
  updated_at: string;
}
const toPr = (r: PrRow): PullRequest => {
  let commits: GitCommit[] = [];
  let files: GitFileChange[] = [];
  try {
    const parsed = JSON.parse(r.stats || '{}') as {
      commits?: GitCommit[];
      files?: GitFileChange[];
    };
    commits = Array.isArray(parsed.commits) ? parsed.commits : [];
    files = Array.isArray(parsed.files) ? parsed.files : [];
  } catch {
    /* tolerate legacy/malformed stats */
  }
  return {
    id: r.id,
    projectId: r.project_id,
    workItemId: r.work_item_id ?? null,
    authorAgentId: r.author_agent_id ?? null,
    reviewerAgentId: r.reviewer_agent_id ?? null,
    title: r.title,
    description: r.description,
    branch: r.branch,
    baseBranch: r.base_branch,
    diff: r.diff,
    status: r.status as PrStatus,
    commits,
    files,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
};

interface PrCommentRow {
  id: string;
  project_id: string;
  pr_id: string;
  body: string;
  target_stream: string | null;
  target_agent_id: string | null;
  work_item_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}
const toPrComment = (r: PrCommentRow): PrComment => ({
  id: r.id,
  projectId: r.project_id,
  prId: r.pr_id,
  body: r.body,
  targetStream: r.target_stream ?? null,
  targetAgentId: r.target_agent_id ?? null,
  workItemId: r.work_item_id ?? null,
  status: r.status as PrComment['status'],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

interface QuestionRow {
  id: string;
  project_id: string;
  agent_id: string | null;
  question: string;
  choices: string | null;
  status: string;
  answer: string | null;
  created_at: string;
  answered_at: string | null;
}
const toQuestion = (r: QuestionRow): Question => ({
  id: r.id,
  projectId: r.project_id,
  agentId: r.agent_id,
  question: r.question,
  choices: r.choices ? (JSON.parse(r.choices) as string[]) : null,
  status: r.status as Question['status'],
  answer: r.answer,
  createdAt: r.created_at,
  answeredAt: r.answered_at,
});

interface NotificationRow {
  id: string;
  project_id: string;
  type: string;
  title: string;
  body: string;
  link: string;
  work_item_id: string | null;
  agent_id: string | null;
  read: number;
  created_at: string;
}
const toNotification = (r: NotificationRow): Notification => ({
  id: r.id,
  projectId: r.project_id,
  type: r.type as NotificationType,
  title: r.title,
  body: r.body,
  link: r.link,
  workItemId: r.work_item_id,
  agentId: r.agent_id,
  read: Boolean(r.read),
  createdAt: r.created_at,
});

/* -------------------------------------------------------------------- store */

/**
 * Typed persistence layer over SQLite. All methods are synchronous
 * (better-sqlite3 is synchronous), which keeps the service layer simple.
 */
export class Store {
  constructor(private readonly db: DB) {}

  /* projects */
  createProject(input: { name: string; repoDir: string; settings: ProjectSettings }): Project {
    const ts = now();
    const row: ProjectRow = {
      id: id('prj'),
      name: input.name,
      repo_dir: input.repoDir,
      settings: JSON.stringify(input.settings),
      created_at: ts,
      updated_at: ts,
    };
    this.db
      .prepare(
        `INSERT INTO projects (id,name,repo_dir,settings,created_at,updated_at)
         VALUES (@id,@name,@repo_dir,@settings,@created_at,@updated_at)`,
      )
      .run(row);
    return toProject(row);
  }

  listProjects(): Project[] {
    return this.db
      .prepare(`SELECT * FROM projects ORDER BY created_at ASC`)
      .all()
      .map((r) => toProject(r as ProjectRow));
  }

  getProject(projectId: string): Project | undefined {
    const r = this.db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId);
    return r ? toProject(r as ProjectRow) : undefined;
  }

  updateProject(
    projectId: string,
    patch: { name?: string; settings?: ProjectSettings },
  ): Project | undefined {
    const existing = this.getProject(projectId);
    if (!existing) return undefined;
    const name = patch.name ?? existing.name;
    const settings = patch.settings ?? existing.settings;
    this.db
      .prepare(`UPDATE projects SET name=?, settings=?, updated_at=? WHERE id=?`)
      .run(name, JSON.stringify(settings), now(), projectId);
    return this.getProject(projectId);
  }

  deleteProject(projectId: string): void {
    this.db.prepare(`DELETE FROM projects WHERE id = ?`).run(projectId);
  }

  /* agents */
  createAgent(a: Omit<Agent, 'id' | 'createdAt' | 'updatedAt'>): Agent {
    const ts = now();
    const row: AgentRow = {
      id: id('agt'),
      project_id: a.projectId,
      kind: a.kind,
      name: a.name,
      display_name: a.displayName,
      description: a.description,
      prompt: a.prompt,
      tools: a.tools ? JSON.stringify(a.tools) : null,
      skills: JSON.stringify(a.skills),
      model: a.model,
      emoji: a.emoji,
      color: a.color,
      catalog_id: a.catalogId,
      status: a.status,
      created_at: ts,
      updated_at: ts,
    };
    this.db
      .prepare(
        `INSERT INTO agents (id,project_id,kind,name,display_name,description,prompt,tools,skills,model,emoji,color,catalog_id,status,created_at,updated_at)
         VALUES (@id,@project_id,@kind,@name,@display_name,@description,@prompt,@tools,@skills,@model,@emoji,@color,@catalog_id,@status,@created_at,@updated_at)`,
      )
      .run(row);
    return toAgent(row);
  }

  listAgents(projectId: string): Agent[] {
    return this.db
      .prepare(`SELECT * FROM agents WHERE project_id = ? ORDER BY kind DESC, created_at ASC`)
      .all(projectId)
      .map((r) => toAgent(r as AgentRow));
  }

  getAgent(agentId: string): Agent | undefined {
    const r = this.db.prepare(`SELECT * FROM agents WHERE id = ?`).get(agentId);
    return r ? toAgent(r as AgentRow) : undefined;
  }

  getAgentByName(projectId: string, name: string): Agent | undefined {
    const r = this.db
      .prepare(`SELECT * FROM agents WHERE project_id=? AND name=?`)
      .get(projectId, name);
    return r ? toAgent(r as AgentRow) : undefined;
  }

  getLead(projectId: string): Agent | undefined {
    const r = this.db
      .prepare(`SELECT * FROM agents WHERE project_id=? AND kind='lead'`)
      .get(projectId);
    return r ? toAgent(r as AgentRow) : undefined;
  }

  updateAgent(
    agentId: string,
    patch: Partial<Omit<Agent, 'id' | 'projectId' | 'kind'>>,
  ): Agent | undefined {
    const existing = this.getAgent(agentId);
    if (!existing) return undefined;
    // Drop undefined keys so a partial patch never clobbers existing values
    // (an undefined binding would also violate NOT NULL columns like emoji/color).
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) clean[k] = v;
    const merged = { ...existing, ...clean } as Agent;
    this.db
      .prepare(
        `UPDATE agents SET display_name=?, description=?, prompt=?, tools=?, skills=?, model=?, emoji=?, color=?, status=?, updated_at=? WHERE id=?`,
      )
      .run(
        merged.displayName,
        merged.description,
        merged.prompt,
        merged.tools ? JSON.stringify(merged.tools) : null,
        JSON.stringify(merged.skills),
        merged.model,
        merged.emoji,
        merged.color,
        merged.status,
        now(),
        agentId,
      );
    return this.getAgent(agentId);
  }

  setAgentStatus(agentId: string, status: AgentStatus): Agent | undefined {
    this.db
      .prepare(`UPDATE agents SET status=?, updated_at=? WHERE id=?`)
      .run(status, now(), agentId);
    return this.getAgent(agentId);
  }

  deleteAgent(agentId: string): void {
    this.db.prepare(`DELETE FROM agents WHERE id = ?`).run(agentId);
    this.db.prepare(`DELETE FROM agent_notes WHERE agent_id = ?`).run(agentId);
    this.db.prepare(`DELETE FROM agent_tasks WHERE agent_id = ?`).run(agentId);
  }

  /* work items */
  createWorkItem(w: {
    projectId: string;
    title: string;
    description: string;
    status: WorkItem['status'];
    priority: WorkItem['priority'];
    assigneeAgentId: string | null;
    kind?: WorkItem['kind'];
    parentId?: string | null;
    stream?: string | null;
    dependsOn?: string[];
    branch?: string | null;
    scheduledAt?: number | null;
    recurrence?: WorkItem['recurrence'];
    progress?: number;
    order?: number;
  }): WorkItem {
    const ts = now();
    const order =
      w.order ??
      (
        this.db
          .prepare(
            `SELECT COALESCE(MAX(ord),0)+1 AS n FROM work_items WHERE project_id=? AND status=?`,
          )
          .get(w.projectId, w.status) as { n: number }
      ).n;
    const row: WorkItemRow = {
      id: id('wi'),
      project_id: w.projectId,
      kind: w.kind ?? 'task',
      parent_id: w.parentId ?? null,
      title: w.title,
      description: w.description,
      status: w.status,
      priority: w.priority,
      stream: w.stream ?? null,
      depends_on: JSON.stringify(w.dependsOn ?? []),
      assignee_agent_id: w.assigneeAgentId,
      branch: w.branch ?? null,
      scheduled_at: w.scheduledAt ?? null,
      recurrence: w.recurrence ?? 'none',
      progress: 0,
      ord: order,
      created_at: ts,
      updated_at: ts,
    };
    this.db
      .prepare(
        `INSERT INTO work_items (id,project_id,kind,parent_id,title,description,status,priority,stream,depends_on,assignee_agent_id,branch,scheduled_at,recurrence,progress,ord,created_at,updated_at)
         VALUES (@id,@project_id,@kind,@parent_id,@title,@description,@status,@priority,@stream,@depends_on,@assignee_agent_id,@branch,@scheduled_at,@recurrence,@progress,@ord,@created_at,@updated_at)`,
      )
      .run(row);
    return toWorkItem(row);
  }

  listWorkItems(projectId: string): WorkItem[] {
    return this.db
      .prepare(`SELECT * FROM work_items WHERE project_id=? ORDER BY ord ASC, created_at ASC`)
      .all(projectId)
      .map((r) => toWorkItem(r as WorkItemRow));
  }

  /** Scheduled items awaiting activation (have a scheduledAt and still in backlog). */
  listScheduledWorkItems(projectId: string): WorkItem[] {
    return this.db
      .prepare(
        `SELECT * FROM work_items WHERE project_id=? AND scheduled_at IS NOT NULL AND status='backlog' ORDER BY scheduled_at ASC`,
      )
      .all(projectId)
      .map((r) => toWorkItem(r as WorkItemRow));
  }

  listChildTasks(parentId: string): WorkItem[] {
    return this.db
      .prepare(`SELECT * FROM work_items WHERE parent_id=? ORDER BY ord ASC, created_at ASC`)
      .all(parentId)
      .map((r) => toWorkItem(r as WorkItemRow));
  }

  getWorkItem(workItemId: string): WorkItem | undefined {
    const r = this.db.prepare(`SELECT * FROM work_items WHERE id=?`).get(workItemId);
    return r ? toWorkItem(r as WorkItemRow) : undefined;
  }

  updateWorkItem(
    workItemId: string,
    patch: Partial<
      Pick<
        WorkItem,
        | 'title'
        | 'description'
        | 'status'
        | 'priority'
        | 'assigneeAgentId'
        | 'order'
        | 'stream'
        | 'branch'
        | 'dependsOn'
        | 'progress'
      >
    >,
  ): WorkItem | undefined {
    const existing = this.getWorkItem(workItemId);
    if (!existing) return undefined;
    const m = { ...existing, ...patch };
    this.db
      .prepare(
        `UPDATE work_items SET title=?, description=?, status=?, priority=?, assignee_agent_id=?, ord=?, stream=?, branch=?, depends_on=?, progress=?, updated_at=? WHERE id=?`,
      )
      .run(
        m.title,
        m.description,
        m.status,
        m.priority,
        m.assigneeAgentId,
        m.order,
        m.stream,
        m.branch,
        JSON.stringify(m.dependsOn ?? []),
        Math.max(0, Math.min(100, Math.round(m.progress ?? 0))),
        now(),
        workItemId,
      );
    return this.getWorkItem(workItemId);
  }

  /** Next assigned, not-yet-done item for an agent (autonomous pull-loop source). */
  nextAssignedItem(projectId: string, agentId: string): WorkItem | undefined {
    const r = this.db
      .prepare(
        `SELECT * FROM work_items WHERE project_id=? AND assignee_agent_id=? AND status IN ('backlog','todo')
         ORDER BY (priority='high') DESC, ord ASC, created_at ASC LIMIT 1`,
      )
      .get(projectId, agentId);
    return r ? toWorkItem(r as WorkItemRow) : undefined;
  }

  deleteWorkItem(workItemId: string): void {
    this.db.prepare(`DELETE FROM work_items WHERE id=?`).run(workItemId);
  }

  /* agent tasks */
  upsertTask(t: {
    projectId: string;
    agentId: string;
    workItemId?: string | null;
    title: string;
    status?: AgentTaskStatus;
  }): AgentTask {
    const existing = this.db
      .prepare(`SELECT * FROM agent_tasks WHERE project_id=? AND agent_id=? AND title=?`)
      .get(t.projectId, t.agentId, t.title) as AgentTaskRow | undefined;
    const ts = now();
    if (existing) {
      this.db
        .prepare(`UPDATE agent_tasks SET status=?, work_item_id=?, updated_at=? WHERE id=?`)
        .run(t.status ?? existing.status, t.workItemId ?? existing.work_item_id, ts, existing.id);
      return toTask({ ...existing, status: t.status ?? existing.status, updated_at: ts });
    }
    const row: AgentTaskRow = {
      id: id('tsk'),
      project_id: t.projectId,
      agent_id: t.agentId,
      work_item_id: t.workItemId ?? null,
      title: t.title,
      status: t.status ?? 'todo',
      created_at: ts,
      updated_at: ts,
    };
    this.db
      .prepare(
        `INSERT INTO agent_tasks (id,project_id,agent_id,work_item_id,title,status,created_at,updated_at)
         VALUES (@id,@project_id,@agent_id,@work_item_id,@title,@status,@created_at,@updated_at)`,
      )
      .run(row);
    return toTask(row);
  }

  listTasks(projectId: string, agentId: string): AgentTask[] {
    return this.db
      .prepare(
        `SELECT * FROM agent_tasks WHERE project_id=? AND agent_id=? ORDER BY created_at ASC`,
      )
      .all(projectId, agentId)
      .map((r) => toTask(r as AgentTaskRow));
  }

  /* agent scratchpad: append-only notes + a single living plan */
  appendNote(n: {
    projectId: string;
    agentId: string;
    workItemId?: string | null;
    content: string;
  }): AgentNote {
    const ts = now();
    const row: AgentNoteRow = {
      id: id('note'),
      project_id: n.projectId,
      agent_id: n.agentId,
      work_item_id: n.workItemId ?? null,
      kind: 'note',
      content: n.content,
      created_at: ts,
      updated_at: ts,
    };
    this.db
      .prepare(
        `INSERT INTO agent_notes (id,project_id,agent_id,work_item_id,kind,content,created_at,updated_at)
         VALUES (@id,@project_id,@agent_id,@work_item_id,@kind,@content,@created_at,@updated_at)`,
      )
      .run(row);
    return toNote(row);
  }

  listNotes(agentId: string): AgentNote[] {
    return this.db
      .prepare(
        `SELECT * FROM agent_notes WHERE agent_id=? AND kind='note' ORDER BY created_at DESC`,
      )
      .all(agentId)
      .map((r) => toNote(r as AgentNoteRow));
  }

  /** Replace the agent's living plan/scratchpad (a single row per agent). */
  setPlan(p: { projectId: string; agentId: string; content: string }): string {
    const ts = now();
    const existing = this.db
      .prepare(`SELECT id FROM agent_notes WHERE agent_id=? AND kind='plan' LIMIT 1`)
      .get(p.agentId) as { id: string } | undefined;
    if (existing) {
      this.db
        .prepare(`UPDATE agent_notes SET content=?, updated_at=? WHERE id=?`)
        .run(p.content, ts, existing.id);
    } else {
      this.db
        .prepare(
          `INSERT INTO agent_notes (id,project_id,agent_id,work_item_id,kind,content,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(id('plan'), p.projectId, p.agentId, null, 'plan', p.content, ts, ts);
    }
    return p.content;
  }

  getPlan(agentId: string): string {
    const row = this.db
      .prepare(`SELECT content FROM agent_notes WHERE agent_id=? AND kind='plan' LIMIT 1`)
      .get(agentId) as { content: string } | undefined;
    return row?.content ?? '';
  }

  /* epic design: the Architect's technical design for an epic, persisted so it can
     be injected into every builder's run prompt (one row per epic, upserted). */
  setEpicDesign(p: { projectId: string; epicId: string; content: string }): void {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO epic_designs (epic_id,project_id,content,updated_at) VALUES (?,?,?,?)
         ON CONFLICT(epic_id) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at`,
      )
      .run(p.epicId, p.projectId, p.content, ts);
  }

  getEpicDesign(epicId: string): string {
    const row = this.db.prepare(`SELECT content FROM epic_designs WHERE epic_id=?`).get(epicId) as
      { content: string } | undefined;
    return row?.content ?? '';
  }

  deleteEpicDesign(epicId: string): void {
    this.db.prepare(`DELETE FROM epic_designs WHERE epic_id=?`).run(epicId);
  }

  /* epic metrics: per-epic delivery/parallelism telemetry recorded at merge time
     (one row per epic, upserted). Read back for aggregation to decide whether
     finer decomposition would pay off. */
  recordEpicMetrics(m: Omit<EpicMetrics, 'createdAt'>): EpicMetrics {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO epic_metrics
           (epic_id,project_id,task_count,builder_count,independent_builders,
            max_concurrent,integration_conflicts,duration_ms,created_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(epic_id) DO UPDATE SET
           task_count=excluded.task_count, builder_count=excluded.builder_count,
           independent_builders=excluded.independent_builders,
           max_concurrent=excluded.max_concurrent,
           integration_conflicts=excluded.integration_conflicts,
           duration_ms=excluded.duration_ms, created_at=excluded.created_at`,
      )
      .run(
        m.epicId,
        m.projectId,
        m.taskCount,
        m.builderCount,
        m.independentBuilders,
        m.maxConcurrent,
        m.integrationConflicts,
        m.durationMs,
        ts,
      );
    return { ...m, createdAt: ts };
  }

  private rowToMetrics(r: EpicMetricsRow): EpicMetrics {
    return {
      epicId: r.epic_id,
      projectId: r.project_id,
      taskCount: r.task_count,
      builderCount: r.builder_count,
      independentBuilders: r.independent_builders,
      maxConcurrent: r.max_concurrent,
      integrationConflicts: r.integration_conflicts,
      durationMs: r.duration_ms,
      createdAt: r.created_at,
    };
  }

  getEpicMetrics(epicId: string): EpicMetrics | undefined {
    const row = this.db.prepare(`SELECT * FROM epic_metrics WHERE epic_id=?`).get(epicId) as
      EpicMetricsRow | undefined;
    return row ? this.rowToMetrics(row) : undefined;
  }

  listEpicMetrics(projectId: string): EpicMetrics[] {
    const rows = this.db
      .prepare(`SELECT * FROM epic_metrics WHERE project_id=? ORDER BY created_at ASC`)
      .all(projectId) as EpicMetricsRow[];
    return rows.map((r) => this.rowToMetrics(r));
  }

  /* acceptance criteria: the Product Manager's structured, testable criteria for
     an epic. replaceCriteria is idempotent (decomposeEpic may re-run) - it swaps
     the full set for an epic in one transaction. */
  replaceCriteria(p: {
    projectId: string;
    epicId: string;
    texts: string[];
  }): AcceptanceCriterion[] {
    const ts = now();
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM acceptance_criteria WHERE epic_id=?`).run(p.epicId);
      const insert = this.db.prepare(
        `INSERT INTO acceptance_criteria (id,project_id,epic_id,text,status,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?)`,
      );
      for (const text of p.texts) {
        insert.run(id('ac'), p.projectId, p.epicId, text, 'open', ts, ts);
      }
    });
    tx();
    return this.listCriteria(p.epicId);
  }

  listCriteria(epicId: string): AcceptanceCriterion[] {
    const rows = this.db
      .prepare(`SELECT * FROM acceptance_criteria WHERE epic_id=? ORDER BY created_at ASC`)
      .all(epicId) as Array<{
      id: string;
      project_id: string;
      epic_id: string;
      text: string;
      status: string;
      created_at: string;
      updated_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      epicId: r.epic_id,
      text: r.text,
      status: r.status as AcceptanceCriterion['status'],
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  setCriterionStatus(criterionId: string, status: AcceptanceCriterion['status']): void {
    this.db
      .prepare(`UPDATE acceptance_criteria SET status=?, updated_at=? WHERE id=?`)
      .run(status, now(), criterionId);
  }

  deleteCriteria(epicId: string): void {
    this.db.prepare(`DELETE FROM acceptance_criteria WHERE epic_id=?`).run(epicId);
  }

  /* verification reports: append-only audit of every gate decision. */
  insertVerification(p: {
    projectId: string;
    workItemId: string;
    agentId: string | null;
    scope: 'task' | 'epic';
    stream: string | null;
    passed: boolean;
    outcome: 'passed' | 'failed' | 'skipped';
    checks: VerificationCheck[];
  }): VerificationReportRecord {
    const ts = now();
    const rid = id('vr');
    this.db
      .prepare(
        `INSERT INTO verification_reports
         (id,project_id,work_item_id,agent_id,scope,stream,passed,outcome,checks,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        rid,
        p.projectId,
        p.workItemId,
        p.agentId,
        p.scope,
        p.stream,
        p.passed ? 1 : 0,
        p.outcome,
        JSON.stringify(p.checks),
        ts,
      );
    return {
      id: rid,
      projectId: p.projectId,
      workItemId: p.workItemId,
      agentId: p.agentId,
      scope: p.scope,
      stream: p.stream,
      passed: p.passed,
      outcome: p.outcome,
      checks: p.checks,
      createdAt: ts,
    };
  }

  private rowToVerification(r: {
    id: string;
    project_id: string;
    work_item_id: string;
    agent_id: string | null;
    scope: string;
    stream: string | null;
    passed: number;
    outcome: string;
    checks: string;
    created_at: string;
  }): VerificationReportRecord {
    let checks: VerificationCheck[] = [];
    try {
      checks = JSON.parse(r.checks) as VerificationCheck[];
    } catch {
      checks = [];
    }
    return {
      id: r.id,
      projectId: r.project_id,
      workItemId: r.work_item_id,
      agentId: r.agent_id,
      scope: r.scope as 'task' | 'epic',
      stream: r.stream,
      passed: r.passed === 1,
      outcome: r.outcome as 'passed' | 'failed' | 'skipped',
      checks,
      createdAt: r.created_at,
    };
  }

  listVerification(workItemId: string): VerificationReportRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM verification_reports WHERE work_item_id=? ORDER BY created_at ASC`)
      .all(workItemId) as Parameters<Store['rowToVerification']>[0][];
    return rows.map((r) => this.rowToVerification(r));
  }

  latestVerification(workItemId: string): VerificationReportRecord | null {
    const r = this.db
      .prepare(
        `SELECT * FROM verification_reports WHERE work_item_id=? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(workItemId) as Parameters<Store['rowToVerification']>[0] | undefined;
    return r ? this.rowToVerification(r) : null;
  }

  listProjectVerification(projectId: string, limit = 200): VerificationReportRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM verification_reports WHERE project_id=? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(projectId, limit) as Parameters<Store['rowToVerification']>[0][];
    return rows.map((r) => this.rowToVerification(r));
  }

  /* events */
  appendEvent(e: {
    projectId: string;
    agentId?: string | null;
    workItemId?: string | null;
    type: AgentEventType;
    summary: string;
    detail?: Record<string, unknown> | null;
  }): AgentEvent {
    const row: AgentEventRow = {
      id: id('evt'),
      project_id: e.projectId,
      agent_id: e.agentId ?? null,
      work_item_id: e.workItemId ?? null,
      type: e.type,
      summary: e.summary,
      detail: e.detail ? JSON.stringify(e.detail) : null,
      created_at: now(),
    };
    this.db
      .prepare(
        `INSERT INTO agent_events (id,project_id,agent_id,work_item_id,type,summary,detail,created_at)
         VALUES (@id,@project_id,@agent_id,@work_item_id,@type,@summary,@detail,@created_at)`,
      )
      .run(row);
    return toEvent(row);
  }

  listEvents(
    projectId: string,
    opts: { agentId?: string | null; limit?: number } = {},
  ): AgentEvent[] {
    const limit = opts.limit ?? 500;
    if (opts.agentId !== undefined) {
      return this.db
        .prepare(
          `SELECT * FROM agent_events WHERE project_id=? AND agent_id IS ? ORDER BY created_at ASC LIMIT ?`,
        )
        .all(projectId, opts.agentId, limit)
        .map((r) => toEvent(r as AgentEventRow));
    }
    return this.db
      .prepare(`SELECT * FROM agent_events WHERE project_id=? ORDER BY created_at ASC LIMIT ?`)
      .all(projectId, limit)
      .map((r) => toEvent(r as AgentEventRow));
  }

  /* threads */
  ensureMainThread(projectId: string): Thread {
    const existing = this.db
      .prepare(`SELECT * FROM threads WHERE project_id=? AND kind='main'`)
      .get(projectId) as ThreadRow | undefined;
    if (existing) return toThread(existing);
    return this.createThread({
      projectId,
      kind: 'main',
      topic: 'Main',
      workItemId: null,
      participantAgentIds: [],
      includesUser: true,
    });
  }

  createThread(t: {
    projectId: string;
    kind: ThreadKind;
    topic: string;
    workItemId?: string | null;
    participantAgentIds?: string[];
    includesUser?: boolean;
  }): Thread {
    const ts = now();
    const row: ThreadRow = {
      id: id('thr'),
      project_id: t.projectId,
      kind: t.kind,
      topic: t.topic,
      status: 'open',
      work_item_id: t.workItemId ?? null,
      participants: JSON.stringify(t.participantAgentIds ?? []),
      includes_user: t.includesUser === false ? 0 : 1,
      created_at: ts,
      updated_at: ts,
    };
    this.db
      .prepare(
        `INSERT INTO threads (id,project_id,kind,topic,status,work_item_id,participants,includes_user,created_at,updated_at)
         VALUES (@id,@project_id,@kind,@topic,@status,@work_item_id,@participants,@includes_user,@created_at,@updated_at)`,
      )
      .run(row);
    return toThread(row);
  }

  listThreads(projectId: string): Thread[] {
    return this.db
      .prepare(`SELECT * FROM threads WHERE project_id=? ORDER BY created_at ASC`)
      .all(projectId)
      .map((r) => toThread(r as ThreadRow));
  }

  getThread(threadId: string): Thread | undefined {
    const r = this.db.prepare(`SELECT * FROM threads WHERE id=?`).get(threadId);
    return r ? toThread(r as ThreadRow) : undefined;
  }

  closeThread(threadId: string): Thread | undefined {
    this.db
      .prepare(`UPDATE threads SET status='closed', updated_at=? WHERE id=?`)
      .run(now(), threadId);
    return this.getThread(threadId);
  }

  renameThread(threadId: string, topic: string): Thread | undefined {
    this.db
      .prepare(`UPDATE threads SET topic=?, updated_at=? WHERE id=?`)
      .run(topic, now(), threadId);
    return this.getThread(threadId);
  }

  /* chat / thread messages */
  appendChat(m: {
    projectId: string;
    threadId: string;
    role: ChatRole;
    authorAgentId?: string | null;
    content: string;
  }): ChatMessage {
    const row: ChatRow = {
      id: id('msg'),
      project_id: m.projectId,
      thread_id: m.threadId,
      role: m.role,
      author_agent_id: m.authorAgentId ?? null,
      content: m.content,
      created_at: now(),
    };
    this.db
      .prepare(
        `INSERT INTO chat_messages (id,project_id,thread_id,role,author_agent_id,content,created_at)
         VALUES (@id,@project_id,@thread_id,@role,@author_agent_id,@content,@created_at)`,
      )
      .run(row);
    return toChat(row);
  }

  updateChat(messageId: string, content: string): ChatMessage | undefined {
    this.db.prepare(`UPDATE chat_messages SET content=? WHERE id=?`).run(content, messageId);
    const r = this.db.prepare(`SELECT * FROM chat_messages WHERE id=?`).get(messageId);
    return r ? toChat(r as ChatRow) : undefined;
  }

  deleteChat(messageId: string): void {
    this.db.prepare(`DELETE FROM chat_messages WHERE id=?`).run(messageId);
  }

  listChat(projectId: string): ChatMessage[] {
    return this.db
      .prepare(`SELECT * FROM chat_messages WHERE project_id=? ORDER BY created_at ASC`)
      .all(projectId)
      .map((r) => toChat(r as ChatRow));
  }

  listThreadMessages(threadId: string): ChatMessage[] {
    return this.db
      .prepare(`SELECT * FROM chat_messages WHERE thread_id=? ORDER BY created_at ASC`)
      .all(threadId)
      .map((r) => toChat(r as ChatRow));
  }

  /* pull requests */
  createPR(p: {
    projectId: string;
    workItemId?: string | null;
    authorAgentId?: string | null;
    title: string;
    description: string;
    branch: string;
    baseBranch: string;
    diff: string;
  }): PullRequest {
    const ts = now();
    const row: PrRow = {
      id: id('pr'),
      project_id: p.projectId,
      work_item_id: p.workItemId ?? null,
      author_agent_id: p.authorAgentId ?? null,
      reviewer_agent_id: null,
      title: p.title,
      description: p.description,
      branch: p.branch,
      base_branch: p.baseBranch,
      diff: p.diff,
      status: 'open',
      stats: '{}',
      created_at: ts,
      updated_at: ts,
    };
    this.db
      .prepare(
        `INSERT INTO pull_requests (id,project_id,work_item_id,author_agent_id,reviewer_agent_id,title,description,branch,base_branch,diff,status,stats,created_at,updated_at)
         VALUES (@id,@project_id,@work_item_id,@author_agent_id,@reviewer_agent_id,@title,@description,@branch,@base_branch,@diff,@status,@stats,@created_at,@updated_at)`,
      )
      .run(row);
    return toPr(row);
  }

  updatePR(
    prId: string,
    patch: Partial<
      Pick<PullRequest, 'status' | 'reviewerAgentId' | 'description' | 'diff' | 'commits' | 'files'>
    >,
  ): PullRequest | undefined {
    const r = this.db.prepare(`SELECT * FROM pull_requests WHERE id=?`).get(prId) as
      PrRow | undefined;
    if (!r) return undefined;
    const m = toPr(r);
    const stats = JSON.stringify({
      commits: patch.commits ?? m.commits,
      files: patch.files ?? m.files,
    });
    this.db
      .prepare(
        `UPDATE pull_requests SET status=?, reviewer_agent_id=?, description=?, diff=?, stats=?, updated_at=? WHERE id=?`,
      )
      .run(
        patch.status ?? m.status,
        patch.reviewerAgentId ?? m.reviewerAgentId,
        patch.description ?? m.description,
        patch.diff ?? m.diff,
        stats,
        now(),
        prId,
      );
    const updated = this.db.prepare(`SELECT * FROM pull_requests WHERE id=?`).get(prId);
    return updated ? toPr(updated as PrRow) : undefined;
  }

  listPRs(projectId: string): PullRequest[] {
    return this.db
      .prepare(`SELECT * FROM pull_requests WHERE project_id=? ORDER BY created_at ASC`)
      .all(projectId)
      .map((r) => toPr(r as PrRow));
  }

  /** Delete a pull request (used when discarding an epic). */
  deletePR(prId: string): void {
    this.db.prepare(`DELETE FROM pr_comments WHERE pr_id=?`).run(prId);
    this.db.prepare(`DELETE FROM pull_requests WHERE id=?`).run(prId);
  }

  /** Delete a thread and its messages (used when discarding an epic). */
  deleteThread(threadId: string): void {
    this.db.prepare(`DELETE FROM chat_messages WHERE thread_id=?`).run(threadId);
    this.db.prepare(`DELETE FROM threads WHERE id=?`).run(threadId);
  }

  getPR(prId: string): PullRequest | undefined {
    const r = this.db.prepare(`SELECT * FROM pull_requests WHERE id=?`).get(prId) as
      PrRow | undefined;
    return r ? toPr(r) : undefined;
  }

  /* pr comments */
  createPrComment(c: {
    projectId: string;
    prId: string;
    body: string;
    targetStream?: string | null;
    targetAgentId?: string | null;
    workItemId?: string | null;
    status?: PrComment['status'];
  }): PrComment {
    const ts = now();
    const row: PrCommentRow = {
      id: id('prc'),
      project_id: c.projectId,
      pr_id: c.prId,
      body: c.body,
      target_stream: c.targetStream ?? null,
      target_agent_id: c.targetAgentId ?? null,
      work_item_id: c.workItemId ?? null,
      status: c.status ?? 'open',
      created_at: ts,
      updated_at: ts,
    };
    this.db
      .prepare(
        `INSERT INTO pr_comments (id,project_id,pr_id,body,target_stream,target_agent_id,work_item_id,status,created_at,updated_at)
         VALUES (@id,@project_id,@pr_id,@body,@target_stream,@target_agent_id,@work_item_id,@status,@created_at,@updated_at)`,
      )
      .run(row);
    return toPrComment(row);
  }

  updatePrComment(
    commentId: string,
    patch: Partial<Pick<PrComment, 'status' | 'workItemId' | 'targetAgentId'>>,
  ): PrComment | undefined {
    const r = this.db.prepare(`SELECT * FROM pr_comments WHERE id=?`).get(commentId) as
      PrCommentRow | undefined;
    if (!r) return undefined;
    const m = toPrComment(r);
    this.db
      .prepare(
        `UPDATE pr_comments SET status=?, work_item_id=?, target_agent_id=?, updated_at=? WHERE id=?`,
      )
      .run(
        patch.status ?? m.status,
        patch.workItemId !== undefined ? patch.workItemId : m.workItemId,
        patch.targetAgentId !== undefined ? patch.targetAgentId : m.targetAgentId,
        now(),
        commentId,
      );
    const updated = this.db.prepare(`SELECT * FROM pr_comments WHERE id=?`).get(commentId);
    return updated ? toPrComment(updated as PrCommentRow) : undefined;
  }

  listPrComments(prId: string): PrComment[] {
    return this.db
      .prepare(`SELECT * FROM pr_comments WHERE pr_id=? ORDER BY created_at ASC`)
      .all(prId)
      .map((r) => toPrComment(r as PrCommentRow));
  }

  listProjectPrComments(projectId: string): PrComment[] {
    return this.db
      .prepare(`SELECT * FROM pr_comments WHERE project_id=? ORDER BY created_at ASC`)
      .all(projectId)
      .map((r) => toPrComment(r as PrCommentRow));
  }

  commentsForWorkItem(workItemId: string): PrComment[] {
    return this.db
      .prepare(`SELECT * FROM pr_comments WHERE work_item_id=? ORDER BY created_at ASC`)
      .all(workItemId)
      .map((r) => toPrComment(r as PrCommentRow));
  }

  /* questions */
  createQuestion(q: {
    projectId: string;
    agentId?: string | null;
    question: string;
    choices?: string[] | null;
  }): Question {
    const row: QuestionRow = {
      id: id('qst'),
      project_id: q.projectId,
      agent_id: q.agentId ?? null,
      question: q.question,
      choices: q.choices ? JSON.stringify(q.choices) : null,
      status: 'pending',
      answer: null,
      created_at: now(),
      answered_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO questions (id,project_id,agent_id,question,choices,status,answer,created_at,answered_at)
         VALUES (@id,@project_id,@agent_id,@question,@choices,@status,@answer,@created_at,@answered_at)`,
      )
      .run(row);
    return toQuestion(row);
  }

  answerQuestion(questionId: string, answer: string): Question | undefined {
    this.db
      .prepare(`UPDATE questions SET answer=?, status='answered', answered_at=? WHERE id=?`)
      .run(answer, now(), questionId);
    const r = this.db.prepare(`SELECT * FROM questions WHERE id=?`).get(questionId);
    return r ? toQuestion(r as QuestionRow) : undefined;
  }

  listQuestions(projectId: string): Question[] {
    return this.db
      .prepare(`SELECT * FROM questions WHERE project_id=? ORDER BY created_at ASC`)
      .all(projectId)
      .map((r) => toQuestion(r as QuestionRow));
  }

  /* notifications */
  createNotification(n: {
    projectId: string;
    type: NotificationType;
    title: string;
    body: string;
    link?: string;
    workItemId?: string | null;
    agentId?: string | null;
  }): Notification {
    const row = {
      id: id('ntf'),
      project_id: n.projectId,
      type: n.type,
      title: n.title,
      body: n.body,
      link: n.link ?? 'chat',
      work_item_id: n.workItemId ?? null,
      agent_id: n.agentId ?? null,
      read: 0,
      created_at: now(),
    };
    this.db
      .prepare(
        `INSERT INTO notifications (id,project_id,type,title,body,link,work_item_id,agent_id,read,created_at)
         VALUES (@id,@project_id,@type,@title,@body,@link,@work_item_id,@agent_id,@read,@created_at)`,
      )
      .run(row);
    return toNotification(row as NotificationRow);
  }

  listNotifications(projectId: string, limit = 200): Notification[] {
    return this.db
      .prepare(`SELECT * FROM notifications WHERE project_id=? ORDER BY created_at DESC LIMIT ?`)
      .all(projectId, limit)
      .map((r) => toNotification(r as NotificationRow));
  }

  markNotificationRead(notificationId: string): Notification | undefined {
    this.db.prepare(`UPDATE notifications SET read=1 WHERE id=?`).run(notificationId);
    const r = this.db.prepare(`SELECT * FROM notifications WHERE id=?`).get(notificationId);
    return r ? toNotification(r as NotificationRow) : undefined;
  }

  markAllNotificationsRead(projectId: string): void {
    this.db.prepare(`UPDATE notifications SET read=1 WHERE project_id=?`).run(projectId);
  }

  /* ------------------------------------------------------------- usage */

  /**
   * Accumulate time + token usage for an (agent, workItem) pair. Upserts on a
   * composite key so repeated turns add up. Returns the running total.
   */
  recordUsage(input: {
    projectId: string;
    workItemId: string | null;
    agentId: string;
    inputTokens?: number;
    outputTokens?: number;
    timeMs?: number;
    turns?: number;
  }): UsageEntry {
    const rowId = `${input.workItemId ?? '_none'}::${input.agentId}`;
    this.db
      .prepare(
        `INSERT INTO work_usage
           (id,project_id,work_item_id,agent_id,input_tokens,output_tokens,time_ms,turns,updated_at)
         VALUES (@id,@project_id,@work_item_id,@agent_id,@input_tokens,@output_tokens,@time_ms,@turns,@updated_at)
         ON CONFLICT(id) DO UPDATE SET
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens,
           time_ms = time_ms + excluded.time_ms,
           turns = turns + excluded.turns,
           updated_at = excluded.updated_at`,
      )
      .run({
        id: rowId,
        project_id: input.projectId,
        work_item_id: input.workItemId,
        agent_id: input.agentId,
        input_tokens: Math.max(0, Math.round(input.inputTokens ?? 0)),
        output_tokens: Math.max(0, Math.round(input.outputTokens ?? 0)),
        time_ms: Math.max(0, Math.round(input.timeMs ?? 0)),
        turns: Math.max(0, Math.round(input.turns ?? 0)),
        updated_at: now(),
      });
    const r = this.db.prepare(`SELECT * FROM work_usage WHERE id=?`).get(rowId) as UsageRow;
    return toUsage(r);
  }

  listUsage(projectId: string): UsageEntry[] {
    return this.db
      .prepare(`SELECT * FROM work_usage WHERE project_id=? ORDER BY updated_at DESC`)
      .all(projectId)
      .map((r) => toUsage(r as UsageRow));
  }
}
