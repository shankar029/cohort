import type { ApprovalMode } from '@shared/index';

/** A specialist agent definition handed to the SDK as a custom agent. */
export interface AgentDef {
  name: string;
  displayName: string;
  description: string;
  prompt: string;
  tools: string[] | null;
  skills: string[];
  model: string;
}

/** Normalized event emitted by any adapter, decoupled from the SDK's wire shape. */
export type AdapterEvent =
  | { kind: 'lead_delta'; messageId: string; delta: string }
  | { kind: 'lead_message'; messageId: string; text: string }
  | { kind: 'reasoning'; agentName: string | null; text: string }
  | {
      kind: 'tool_call';
      agentName: string | null;
      toolName: string;
      detail?: Record<string, unknown>;
    }
  | {
      kind: 'tool_result';
      agentName: string | null;
      toolName: string;
      detail?: Record<string, unknown>;
    }
  | { kind: 'subagent_started'; agentName: string; displayName: string; description?: string }
  | {
      kind: 'subagent_completed';
      agentName: string;
      displayName: string;
      detail?: Record<string, unknown>;
    }
  | { kind: 'subagent_failed'; agentName: string; displayName: string; error: string }
  | { kind: 'task_update'; agentName: string; title: string; status: 'todo' | 'doing' | 'done' }
  | { kind: 'idle' };

export interface PermissionAsk {
  kind: 'read' | 'write' | 'shell' | 'mcp' | 'custom-tool' | 'url' | string;
  agentName: string | null;
  toolName?: string;
  fileName?: string;
  command?: string;
}
export type PermissionReply = 'approve' | 'reject';

export interface UserInputAsk {
  agentName: string | null;
  question: string;
  choices?: string[];
}

/** Callbacks the orchestrator supplies when creating a team session. */
export interface TeamSessionCallbacks {
  onEvent: (event: AdapterEvent) => void;
  onPermission: (ask: PermissionAsk) => Promise<PermissionReply>;
  onUserInput: (ask: UserInputAsk) => Promise<string>;
}

export interface TeamSessionConfig extends TeamSessionCallbacks {
  projectId: string;
  workingDirectory: string;
  leadName: string;
  leadDisplayName: string;
  leadModel: string;
  leadPrompt: string;
  specialists: AgentDef[];
  skillDirectories: string[];
  approvalMode: ApprovalMode;
}

/** A live team session for a single project. */
export interface TeamSession {
  /** Send a prompt to the Team Lead. Streams via callbacks; resolves when idle. */
  send(prompt: string, messageId: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
}

/** Factory for team sessions. Implemented by the Real (SDK) and Fake adapters. */
export interface CopilotAdapter {
  readonly name: string;
  createTeamSession(config: TeamSessionConfig): Promise<TeamSession>;
  /** Models available to the authenticated account (for per-agent selection). */
  listModels(): Promise<string[]>;
  /** Release any process-wide resources (e.g. the CopilotClient). */
  shutdown(): Promise<void>;
}
