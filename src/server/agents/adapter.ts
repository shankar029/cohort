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
  approvalMode: ApprovalMode;
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
