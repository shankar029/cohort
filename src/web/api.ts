import type {
  Agent,
  AgentEvent,
  AgentTask,
  ChatMessage,
  CreateAgentInput,
  CreateProjectInput,
  CreateWorkItemInput,
  Project,
  Question,
  SkillInfo,
  UpdateProjectSettingsInput,
  UpdateWorkItemInput,
  WorkItem,
} from '@shared/index';

/** Shape of the catalog entries returned by the API. */
export interface CatalogAgentDTOShape {
  id: string;
  name: string;
  displayName: string;
  description: string;
  emoji: string;
  color: string;
  tools: string[] | null;
  suggestedSkills: string[];
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const message = (body && (body.error as string)) || `Request failed (${res.status})`;
    throw new Error(message);
  }
  return body as T;
}

export const api = {
  listProjects: () => request<{ projects: Project[] }>('/api/projects'),
  createProject: (input: CreateProjectInput) =>
    request<{ project: Project; agents: Agent[] }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  getProject: (id: string) =>
    request<{ project: Project; agents: Agent[]; workItems: WorkItem[]; questions: Question[] }>(
      `/api/projects/${id}`,
    ),
  updateProject: (id: string, input: UpdateProjectSettingsInput) =>
    request<{ project: Project }>(`/api/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  deleteProject: (id: string) => request<void>(`/api/projects/${id}`, { method: 'DELETE' }),

  catalog: () => request<{ agents: CatalogAgentDTOShape[] }>('/api/catalog'),
  skills: (projectId: string) =>
    request<{ skills: SkillInfo[] }>(`/api/projects/${projectId}/skills`),

  createAgent: (projectId: string, input: CreateAgentInput) =>
    request<{ agent: Agent }>(`/api/projects/${projectId}/agents`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateAgent: (agentId: string, input: Partial<CreateAgentInput>) =>
    request<{ agent: Agent }>(`/api/agents/${agentId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  deleteAgent: (agentId: string) => request<void>(`/api/agents/${agentId}`, { method: 'DELETE' }),
  agentTasks: (agentId: string) => request<{ tasks: AgentTask[] }>(`/api/agents/${agentId}/tasks`),
  agentEvents: (agentId: string) =>
    request<{ events: AgentEvent[] }>(`/api/agents/${agentId}/events`),

  createWorkItem: (projectId: string, input: CreateWorkItemInput) =>
    request<{ workItem: WorkItem }>(`/api/projects/${projectId}/workitems`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateWorkItem: (workItemId: string, input: UpdateWorkItemInput) =>
    request<{ workItem: WorkItem }>(`/api/workitems/${workItemId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  deleteWorkItem: (workItemId: string) =>
    request<void>(`/api/workitems/${workItemId}`, { method: 'DELETE' }),

  chatHistory: (projectId: string) =>
    request<{ messages: ChatMessage[] }>(`/api/projects/${projectId}/chat`),
  sendChat: (projectId: string, content: string) =>
    request<{ accepted: boolean }>(`/api/projects/${projectId}/chat`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),

  events: (projectId: string) =>
    request<{ events: AgentEvent[] }>(`/api/projects/${projectId}/events`),
  models: () => request<{ models: string[] }>('/api/models'),
  questions: (projectId: string) =>
    request<{ questions: Question[] }>(`/api/projects/${projectId}/questions`),
  answerQuestion: (questionId: string, answer: string) =>
    request<{ ok: boolean }>(`/api/questions/${questionId}/answer`, {
      method: 'POST',
      body: JSON.stringify({ answer }),
    }),
};
