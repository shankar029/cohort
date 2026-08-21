/**
 * Core domain model for ateam. These types are the single source of truth shared
 * between the server and the web client.
 */

/** Kanban columns for the project board. */
export const WORK_ITEM_STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'done'] as const;
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

export const WORK_ITEM_PRIORITIES = ['low', 'medium', 'high'] as const;
export type WorkItemPriority = (typeof WORK_ITEM_PRIORITIES)[number];

/** Live status of an agent. */
export const AGENT_STATUSES = ['idle', 'working', 'needs_input', 'blocked', 'done'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** An agent is either the single orchestrating Team Lead or a specialist. */
export type AgentKind = 'lead' | 'specialist';

/** How tool permissions are handled for a project's agents. */
export const APPROVAL_MODES = ['auto-workspace', 'manual'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export interface ProjectSettings {
  defaultModel: string;
  approvalMode: ApprovalMode;
  /** Extra home roots to scan for skills, in addition to the built-in defaults. */
  extraSkillRoots: string[];
}

export interface Project {
  id: string;
  name: string;
  /** Absolute path to the locally checked-out repository the team works in. */
  repoDir: string;
  settings: ProjectSettings;
  createdAt: string;
  updatedAt: string;
}

export interface Agent {
  id: string;
  projectId: string;
  kind: AgentKind;
  /** Stable machine name used as the SDK custom-agent name (unique within a project). */
  name: string;
  displayName: string;
  description: string;
  /** System prompt / persona. */
  prompt: string;
  /** Tool allow-list; null means "all tools". */
  tools: string[] | null;
  /** Skill names to preload into the agent's context. */
  skills: string[];
  model: string;
  emoji: string;
  color: string;
  /** Catalog template id this agent was created from, if any. */
  catalogId: string | null;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
}

export const WORK_ITEM_RECURRENCES = ['none', 'hourly', 'daily', 'weekly'] as const;
export type WorkItemRecurrence = (typeof WORK_ITEM_RECURRENCES)[number];

export interface WorkItem {
  id: string;
  projectId: string;
  /** 'epic' = a user request the Lead decomposes; 'task' = a unit assigned to an agent. */
  kind: 'epic' | 'task';
  /** Parent epic id for tasks; null for epics. */
  parentId: string | null;
  title: string;
  description: string;
  status: WorkItemStatus;
  priority: WorkItemPriority;
  /** Stream/discipline label for tasks (e.g. 'frontend', 'backend', 'qa'). */
  stream: string | null;
  /** Ids of sibling tasks this task depends on. */
  dependsOn: string[];
  assigneeAgentId: string | null;
  /** Git branch the assignee works on, if any. */
  branch: string | null;
  /** Epoch ms at which a scheduled item should activate (move to todo); null = not scheduled. */
  scheduledAt: number | null;
  /** Recurrence for scheduled items. */
  recurrence: WorkItemRecurrence;
  /** Sort order within a column. */
  order: number;
  /** Completion percentage 0-100, kept current by the assignee agent. */
  progress: number;
  createdAt: string;
  updatedAt: string;
}

/** A task on an individual agent's personal task board. */
export const AGENT_TASK_STATUSES = ['todo', 'doing', 'done'] as const;
export type AgentTaskStatus = (typeof AGENT_TASK_STATUSES)[number];

export interface AgentTask {
  id: string;
  projectId: string;
  agentId: string;
  workItemId: string | null;
  title: string;
  status: AgentTaskStatus;
  createdAt: string;
  updatedAt: string;
}

/** A free-form note an agent writes to its own scratchpad (append-only). */
export interface AgentNote {
  id: string;
  projectId: string;
  agentId: string;
  workItemId: string | null;
  content: string;
  createdAt: string;
}

/** Types of entries in an agent's activity log. */
export const AGENT_EVENT_TYPES = [
  'message',
  'reasoning',
  'tool_call',
  'tool_result',
  'subagent_started',
  'subagent_completed',
  'subagent_failed',
  'status_change',
  'escalation',
  'discussion',
  'git',
  'pull_request',
  'system',
] as const;
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export interface AgentEvent {
  id: string;
  projectId: string;
  /** Null for main-session / Team-Lead-level events. */
  agentId: string | null;
  workItemId: string | null;
  type: AgentEventType;
  /** Short human-readable summary. */
  summary: string;
  /** Optional structured detail (tool args, full text, etc.). */
  detail: Record<string, unknown> | null;
  createdAt: string;
}

export type ChatRole = 'user' | 'agent';

/** A message in a conversation thread (main or group). */
export interface ChatMessage {
  id: string;
  projectId: string;
  threadId: string;
  role: ChatRole;
  /** The authoring agent; null when the author is the user. */
  authorAgentId: string | null;
  content: string;
  createdAt: string;
}

export const THREAD_KINDS = ['main', 'group', 'dm'] as const;
export type ThreadKind = (typeof THREAD_KINDS)[number];

/** A conversation: the main user↔team channel, or a Lead-moderated group chat. */
export interface Thread {
  id: string;
  projectId: string;
  kind: ThreadKind;
  topic: string;
  status: 'open' | 'closed';
  /** Related epic/task, if the thread is about a work item. */
  workItemId: string | null;
  participantAgentIds: string[];
  includesUser: boolean;
  createdAt: string;
  updatedAt: string;
}

export const PR_STATUSES = ['open', 'changes_requested', 'approved', 'merged'] as const;
export type PrStatus = (typeof PR_STATUSES)[number];

/** A pull request raised by an agent and reviewed by another before merge. */
export interface PullRequest {
  id: string;
  projectId: string;
  workItemId: string | null;
  authorAgentId: string | null;
  reviewerAgentId: string | null;
  title: string;
  description: string;
  branch: string;
  baseBranch: string;
  diff: string;
  status: PrStatus;
  createdAt: string;
  updatedAt: string;
}

export const PR_COMMENT_STATUSES = ['open', 'resolved'] as const;
export type PrCommentStatus = (typeof PR_COMMENT_STATUSES)[number];

/** A specific review comment on a PR, routed to a stream and its fix task. */
export interface PrComment {
  id: string;
  projectId: string;
  prId: string;
  body: string;
  targetStream: string | null;
  targetAgentId: string | null;
  /** The fix task the Team Lead assigned to address this comment. */
  workItemId: string | null;
  status: PrCommentStatus;
  createdAt: string;
  updatedAt: string;
}

export const QUESTION_STATUSES = ['pending', 'answered'] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

/** An escalation surfaced to the user (specialist → Team Lead → user). */
export interface Question {
  id: string;
  projectId: string;
  /** The agent that raised the question (may be the Team Lead itself). */
  agentId: string | null;
  question: string;
  choices: string[] | null;
  status: QuestionStatus;
  answer: string | null;
  createdAt: string;
  answeredAt: string | null;
}

/** A discovered skill (SKILL.md) available to inject into agents. */
export interface SkillInfo {
  name: string;
  description: string;
  /** Absolute path to the skill directory containing SKILL.md. */
  path: string;
  /** 'home' = user/global roots, 'project' = inside the project's repo. */
  source: 'home' | 'project';
}

export const NOTIFICATION_TYPES = [
  'epic',
  'plan',
  'progress',
  'task',
  'pr',
  'review',
  'merge',
  'question',
  'system',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** A user-facing notification recorded for the notifications panel. */
export interface Notification {
  id: string;
  projectId: string;
  type: NotificationType;
  title: string;
  body: string;
  /** In-project route to open when clicked, e.g. 'chat', 'board', 'pulls', 'agents/<id>'. */
  link: string;
  workItemId: string | null;
  agentId: string | null;
  read: boolean;
  createdAt: string;
}
