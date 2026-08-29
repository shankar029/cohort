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
  /** When true the team is paused: no new agent-driven work starts. */
  paused?: boolean;
  /**
   * When true, every agent turn (prompt, response, reasoning, tool calls) is
   * recorded to disk for later review. Off by default.
   */
  recordSessions?: boolean;
  /**
   * Command used to verify the build during QA sign-off (e.g. `npm test`,
   * `pytest`, `go test ./...`). When set it overrides auto-detection from
   * package.json. QA cannot sign off unless this command actually passes.
   */
  testCommand?: string;
  /**
   * Command used for the per-task build gate (does the code still compile?).
   * When set it overrides auto-detection (`typecheck` > `build` > `compile`).
   * A build task cannot advance to review if this command fails.
   */
  buildCommand?: string;
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

/**
 * Accumulated time + model-token usage an agent has spent, keyed by work item.
 * `workItemId` is null for effort not tied to a board item (e.g. direct Lead chat).
 */
export interface UsageEntry {
  projectId: string;
  workItemId: string | null;
  agentId: string;
  inputTokens: number;
  outputTokens: number;
  /** Wall-clock milliseconds the agent spent working (across turns). */
  timeMs: number;
  /** Number of completed agent turns contributing to this entry. */
  turns: number;
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
  'discussion',
  'git',
  'pull_request',
  'system',
  'verification',
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
  /** Commits that landed on the branch (captured at merge, kept after cleanup). */
  commits: GitCommit[];
  /** Files changed on the branch (captured at merge, kept after cleanup). */
  files: GitFileChange[];
  createdAt: string;
  updatedAt: string;
}

export const PR_COMMENT_STATUSES = ['open', 'resolved'] as const;
export type PrCommentStatus = (typeof PR_COMMENT_STATUSES)[number];

/* ----------------------------------------------------- git visibility (Git page) */

/** A single commit on an epic branch. */
export interface GitCommit {
  hash: string;
  subject: string;
  author: string;
  /** ISO date. */
  date: string;
}

/** A file changed on an epic branch vs its base. `added`/`removed` are -1 for binary. */
export interface GitFileChange {
  path: string;
  added: number;
  removed: number;
}

/** Per-task git evidence surfaced on the Git page and in completion reports. */
export interface EpicTaskGit {
  id: string;
  title: string;
  stream: string | null;
  status: WorkItemStatus;
  assigneeAgentId: string | null;
}

/** Git state for one epic: its branch, worktree, commits, files and PR. */
export interface EpicGit {
  epicId: string;
  title: string;
  status: WorkItemStatus;
  branch: string | null;
  baseBranch: string;
  /** Absolute path of the isolated epic clone; null once reclaimed after merge. */
  worktreePath: string | null;
  /** Whether the epic clone still exists on disk (work in flight). */
  worktreeActive: boolean;
  commits: GitCommit[];
  files: GitFileChange[];
  prId: string | null;
  prStatus: PrStatus | null;
  tasks: EpicTaskGit[];
}

/** Repo-wide git snapshot grouped by epic, returned by GET /projects/:id/git. */
export interface GitSnapshot {
  baseBranch: string;
  /** Absolute root under which all epic clones live. */
  worktreeRoot: string;
  /** ateam epic branches present in the main repo. */
  branches: string[];
  epics: EpicGit[];
}

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

export const CRITERION_STATUSES = ['open', 'met', 'failed'] as const;
export type CriterionStatus = (typeof CRITERION_STATUSES)[number];

/**
 * A structured, testable acceptance criterion for an epic, authored by the
 * Product Manager. Persisted (not just posted to chat) so later gates can map
 * each criterion to a test and block merge until all are met.
 */
export interface AcceptanceCriterion {
  id: string;
  projectId: string;
  /** The epic (work item) this criterion belongs to. */
  epicId: string;
  /** The criterion text, ideally in Given/When/Then form. */
  text: string;
  status: CriterionStatus;
  createdAt: string;
  updatedAt: string;
}

/** A single deterministic verification check within a gate report. */
export interface VerificationCheck {
  id: string;
  severity: 'required' | 'advisory';
  status: 'pass' | 'fail' | 'skip' | 'error';
  detail: string;
  evidence?: unknown;
}

/**
 * Persisted, auditable record of a verification gate decision for a work item.
 * A task/epic may not reach a terminal state without a passing (or explicitly
 * overridden) report; the history is append-only so a run is fully auditable.
 */
export interface VerificationReportRecord {
  id: string;
  projectId: string;
  workItemId: string;
  agentId: string | null;
  scope: 'task' | 'epic';
  stream: string | null;
  passed: boolean;
  outcome: 'passed' | 'failed' | 'skipped';
  checks: VerificationCheck[];
  createdAt: string;
}

/**
 * Per-epic delivery/parallelism telemetry, recorded when an epic merges. Used to
 * decide whether finer decomposition (more tasks per stream) would actually pay
 * off, and to tune the per-epic concurrency cap.
 */
export interface EpicMetrics {
  epicId: string;
  projectId: string;
  /** Total child tasks (builders + verifiers). */
  taskCount: number;
  /** Builder tasks (excludes verifier/QA/review sign-off tasks). */
  builderCount: number;
  /** Builder tasks with no dependency on a sibling — the parallelism ceiling. */
  independentBuilders: number;
  /** Observed peak of simultaneously-running child tasks. */
  maxConcurrent: number;
  /** How many task integrations hit a merge conflict. */
  integrationConflicts: number;
  /** Wall-clock from epic creation to merge, in ms. */
  durationMs: number;
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

/** A single recorded event that occurred during an agent turn. */
export interface RecordedSessionEvent {
  at: string;
  kind: 'reasoning' | 'tool_call' | 'tool_result' | 'usage';
  label: string;
  detail?: Record<string, unknown> | null;
}

/**
 * A full recording of one agent turn: the exact prompt it received, the reply it
 * produced, every reasoning/tool step in between, and timing. Written to disk
 * (one JSON object per line) when a project has session recording enabled.
 */
export interface RecordedTurn {
  id: string;
  projectId: string;
  agentId: string | null;
  agentName: string;
  agentKind: AgentKind;
  workItemId: string | null;
  workItemTitle: string | null;
  threadId: string;
  cwd: string;
  model: string;
  prompt: string;
  response: string;
  events: RecordedSessionEvent[];
  /** Summed input/output tokens across this turn's per-call usage events. */
  inputTokens: number;
  outputTokens: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

/** Lightweight list view of a recorded turn (heavy fields replaced by previews). */
export interface RecordedTurnSummary {
  id: string;
  projectId: string;
  agentId: string | null;
  agentName: string;
  agentKind: AgentKind;
  workItemId: string | null;
  workItemTitle: string | null;
  model: string;
  promptPreview: string;
  responsePreview: string;
  eventCount: number;
  toolCount: number;
  inputTokens: number;
  outputTokens: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}
