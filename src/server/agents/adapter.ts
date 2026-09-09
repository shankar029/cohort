import type { ApprovalMode } from '@shared/index';

/**
 * v2 adapter seam: one session per agent (independent actors), replacing the
 * single team-session + SDK sub-agents model. The orchestrator owns the actor
 * system and routes messages between agents, the main thread, and group chats.
 */

/** A streamed event from a single agent's own session. */
export type SessionEvent =
  | { kind: 'delta'; messageId: string; delta: string }
  | { kind: 'message'; messageId: string; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool_call'; toolName: string; detail?: Record<string, unknown> }
  | { kind: 'tool_result'; toolName: string; detail?: Record<string, unknown> }
  | { kind: 'usage'; inputTokens: number; outputTokens: number; model: string; durationMs: number }
  | { kind: 'idle' };

export interface PermissionAsk {
  kind: 'read' | 'write' | 'shell' | 'mcp' | 'custom-tool' | 'url' | string;
  toolName?: string;
  fileName?: string;
  command?: string;
}
export type PermissionReply = 'approve' | 'reject';

export interface UserInputAsk {
  question: string;
  choices?: string[];
}

/** Minimal timing capability handed to agent tools (implemented by SchedulerService). */
export interface Scheduler {
  sleep(ms: number, owner?: string): Promise<void>;
}

/**
 * App-level capabilities exposed to an agent as first-class tools. These map to the
 * same store/bus the UI uses, so an agent creating/moving a card or posting a message
 * shows up live in the board and chat. Implemented by the orchestrator per agent.
 */
export interface AgentAppTools {
  updateProgress(input: { progress: number; workItemId?: string | null; note?: string }): {
    ok: boolean;
  };
  postMessage(input: { content: string; threadId?: string }): { ok: boolean };
  requestGroupChat(input: { topic: string }): { ok: boolean };
  addReviewComment(input: { body: string; targetStream?: string | null }): { ok: boolean };
  writeNote(input: { content: string; workItemId?: string | null }): { ok: boolean };
  updatePlan(input: { content: string }): { ok: boolean };
  /**
   * Lead-only: hand an arbitrary AD-HOC sub-task to the right specialist (who has
   * the full real toolset — shell, probe_app, read) and get their report back. This
   * is for bounded, reporting work (verify, run tests, investigate, inspect, explain)
   * — NOT deliverable changes, which stay on the reviewed board/epic flow. Resolves
   * with the specialist's report so the Lead can answer the user directly.
   */
  delegate(input: { task: string; specialist?: string | null; context?: string | null }): Promise<{
    ok: boolean;
    specialist?: string;
    report?: string;
    error?: string;
  }>;
  listBoard(): {
    items: Array<{
      id: string;
      title: string;
      status: string;
      stream: string | null;
      assignee: string | null;
    }>;
  };
}

export interface AgentSessionCallbacks {
  onEvent: (event: SessionEvent) => void;
  onPermission: (ask: PermissionAsk) => Promise<PermissionReply>;
  onUserInput: (ask: UserInputAsk) => Promise<string>;
}

export interface AgentSessionConfig extends AgentSessionCallbacks {
  projectId: string;
  agentId: string;
  agentName: string;
  displayName: string;
  role: 'lead' | 'specialist';
  /** System prompt / persona. */
  persona: string;
  model: string;
  tools: string[] | null;
  skills: string[];
  workingDirectory: string;
  skillDirectories: string[];
  /**
   * Skill names to DISABLE for this agent's session. We scope skills per agent by
   * loading the full discovery pool via `skillDirectories` (so names resolve) and
   * disabling every discovered skill the agent was NOT given. Empty `skills` =>
   * everything disabled (opt-in). Name-granular, so skills that share a parent
   * directory don't leak into an agent that didn't select them.
   */
  disabledSkills: string[];
  approvalMode: ApprovalMode;
  /** Timing capability backing the agent's `wait` / `poll` tools. */
  scheduler?: Scheduler;
  /** App capabilities backing the agent's board/chat tools. */
  appTools?: AgentAppTools;
}

/** A live session for a single agent. `ask` resolves with the final message text. */
export interface AgentSession {
  ask(prompt: string, messageId: string): Promise<string>;
  dispose(): Promise<void>;
}

/** Factory for per-agent sessions. Implemented by the Real (SDK) and Fake adapters. */
export interface CopilotAdapter {
  readonly name: string;
  createAgentSession(config: AgentSessionConfig): Promise<AgentSession>;
  /** Models available to the authenticated account (for per-agent selection). */
  listModels(): Promise<string[]>;
  /** Release any process-wide resources (e.g. the CopilotClient). */
  shutdown(): Promise<void>;
}
