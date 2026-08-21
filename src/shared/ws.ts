import type {
  Agent,
  AgentEvent,
  AgentStatus,
  AgentNote,
  AgentTask,
  ChatMessage,
  Project,
  PullRequest,
  Question,
  Notification,
  Thread,
  WorkItem,
} from './domain';

/**
 * Messages pushed from the server to the browser over the WebSocket. The client
 * filters by `projectId`. Every message is a discriminated union on `type`.
 */
export type ServerMessage =
  | { type: 'event.appended'; projectId: string; event: AgentEvent }
  | { type: 'agent.status'; projectId: string; agentId: string; status: AgentStatus }
  | { type: 'agent.updated'; projectId: string; agent: Agent }
  | { type: 'workitem.updated'; projectId: string; workItem: WorkItem }
  | { type: 'workitem.deleted'; projectId: string; workItemId: string }
  | { type: 'task.updated'; projectId: string; task: AgentTask }
  | { type: 'agent_note.appended'; projectId: string; agentId: string; note: AgentNote }
  | { type: 'agent_plan.updated'; projectId: string; agentId: string; plan: string }
  | { type: 'chat.message'; projectId: string; message: ChatMessage }
  | { type: 'chat.delta'; projectId: string; messageId: string; delta: string }
  | { type: 'chat.deleted'; projectId: string; messageId: string }
  | { type: 'notification.created'; projectId: string; notification: Notification }
  | { type: 'thread.updated'; projectId: string; thread: Thread }
  | { type: 'pull_request.updated'; projectId: string; pr: PullRequest }
  | { type: 'question.updated'; projectId: string; question: Question }
  | { type: 'project.updated'; project: Project }
  | { type: 'project.deleted'; projectId: string };

export interface ApiError {
  error: string;
  details?: unknown;
}
