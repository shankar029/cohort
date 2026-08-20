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

export interface WorkItem {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: WorkItemStatus;
  priority: WorkItemPriority;
  assigneeAgentId: string | null;
  /** Sort order within a column. */
  order: number;
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

export type ChatRole = 'user' | 'lead';

export interface ChatMessage {
  id: string;
  projectId: string;
  role: ChatRole;
  content: string;
  createdAt: string;
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
