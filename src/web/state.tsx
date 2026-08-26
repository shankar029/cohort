import React, { createContext, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import type {
  Agent,
  AgentEvent,
  AgentNote,
  AgentTask,
  ChatMessage,
  Project,
  Question,
  ServerMessage,
  WorkItem,
  PullRequest,
  Notification,
  PrComment,
  Thread,
} from '@shared/index';
import { api } from './api';

export interface ProjectBundle {
  agents: Agent[];
  workItems: WorkItem[];
  chat: ChatMessage[];
  questions: Question[];
  tasksByAgent: Record<string, AgentTask[]>;
  notesByAgent: Record<string, AgentNote[]>;
  plansByAgent: Record<string, string>;
  events: AgentEvent[];
  pulls: PullRequest[];
  threads: Thread[];
  notifications: Notification[];
  prComments: PrComment[];
  loaded: boolean;
}

interface State {
  projects: Project[];
  projectsLoaded: boolean;
  bundles: Record<string, ProjectBundle>;
  wsConnected: boolean;
  /** Per-project epoch-ms the user last viewed the Threads page (for unread badge). */
  threadsSeenAt: Record<string, number>;
}

const THREADS_SEEN_KEY = 'ateam:threadsSeenAt';

function loadThreadsSeen(): Record<string, number> {
  try {
    const raw = localStorage.getItem(THREADS_SEEN_KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

const emptyBundle = (): ProjectBundle => ({
  agents: [],
  workItems: [],
  chat: [],
  questions: [],
  tasksByAgent: {},
  notesByAgent: {},
  plansByAgent: {},
  events: [],
  pulls: [],
  threads: [],
  notifications: [],
  prComments: [],
  loaded: false,
});

type Action =
  | { type: 'SET_PROJECTS'; projects: Project[] }
  | { type: 'UPSERT_PROJECT'; project: Project }
  | { type: 'REMOVE_PROJECT'; projectId: string }
  | { type: 'SET_BUNDLE'; projectId: string; bundle: Partial<ProjectBundle> }
  | { type: 'UPSERT_AGENT'; projectId: string; agent: Agent }
  | { type: 'REMOVE_AGENT'; projectId: string; agentId: string }
  | { type: 'WS'; message: ServerMessage }
  | { type: 'WS_BATCH'; messages: ServerMessage[] }
  | { type: 'WS_STATUS'; connected: boolean }
  | { type: 'MARK_THREADS_SEEN'; projectId: string; at: number };

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const idx = list.findIndex((x) => x.id === item.id);
  if (idx === -1) return [...list, item];
  const next = list.slice();
  next[idx] = item;
  return next;
}

function withBundle(
  state: State,
  projectId: string,
  fn: (b: ProjectBundle) => ProjectBundle,
): State {
  const current = state.bundles[projectId] ?? emptyBundle();
  return { ...state, bundles: { ...state.bundles, [projectId]: fn(current) } };
}

function applyWs(state: State, message: ServerMessage): State {
  switch (message.type) {
    case 'project.updated':
      return { ...state, projects: upsert(state.projects, message.project) };
    case 'project.deleted': {
      const { [message.projectId]: _removed, ...rest } = state.bundles;
      return {
        ...state,
        projects: state.projects.filter((p) => p.id !== message.projectId),
        bundles: rest,
      };
    }
    default:
      break;
  }
  const projectId = 'projectId' in message ? message.projectId : undefined;
  if (!projectId || !state.bundles[projectId]) return state; // only track loaded projects
  return withBundle(state, projectId, (b) => {
    switch (message.type) {
      case 'agent.updated':
        return { ...b, agents: upsert(b.agents, message.agent) };
      case 'agent.status':
        return {
          ...b,
          agents: b.agents.map((a) =>
            a.id === message.agentId ? { ...a, status: message.status } : a,
          ),
        };
      case 'workitem.updated':
        return { ...b, workItems: upsert(b.workItems, message.workItem) };
      case 'workitem.deleted':
        return { ...b, workItems: b.workItems.filter((w) => w.id !== message.workItemId) };
      case 'task.updated': {
        const list = b.tasksByAgent[message.task.agentId] ?? [];
        return {
          ...b,
          tasksByAgent: { ...b.tasksByAgent, [message.task.agentId]: upsert(list, message.task) },
        };
      }
      case 'chat.message': {
        // Never let an (empty) placeholder re-broadcast clobber text we've already
        // streamed/received for the same message.
        const existing = b.chat.find((m) => m.id === message.message.id);
        if (existing && existing.content && !message.message.content) return b;
        return { ...b, chat: upsert(b.chat, message.message) };
      }
      case 'chat.delta':
        return {
          ...b,
          chat: b.chat.map((m) =>
            m.id === message.messageId ? { ...m, content: m.content + message.delta } : m,
          ),
        };
      case 'chat.deleted':
        return { ...b, chat: b.chat.filter((m) => m.id !== message.messageId) };
      case 'question.updated':
        return { ...b, questions: upsert(b.questions, message.question) };
      case 'pull_request.updated':
        return { ...b, pulls: upsert(b.pulls, message.pr) };
      case 'agent_note.appended':
        return {
          ...b,
          notesByAgent: {
            ...b.notesByAgent,
            [message.agentId]: [message.note, ...(b.notesByAgent[message.agentId] ?? [])],
          },
        };
      case 'agent_plan.updated':
        return {
          ...b,
          plansByAgent: { ...b.plansByAgent, [message.agentId]: message.plan },
        };
      case 'thread.updated':
        return { ...b, threads: upsert(b.threads, message.thread) };
      case 'notification.created':
        return { ...b, notifications: [message.notification, ...b.notifications].slice(0, 300) };
      case 'pr_comment.updated':
        return { ...b, prComments: upsert(b.prComments, message.comment) };
      case 'event.appended':
        return { ...b, events: [...b.events, message.event].slice(-1000) };
      default:
        return b;
    }
  });
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'SET_PROJECTS':
      return { ...state, projects: action.projects, projectsLoaded: true };
    case 'UPSERT_PROJECT':
      return { ...state, projects: upsert(state.projects, action.project) };
    case 'REMOVE_PROJECT': {
      const { [action.projectId]: _removed, ...rest } = state.bundles;
      return {
        ...state,
        projects: state.projects.filter((p) => p.id !== action.projectId),
        bundles: rest,
      };
    }
    case 'SET_BUNDLE':
      return withBundle(state, action.projectId, (b) => ({ ...b, ...action.bundle }));
    case 'UPSERT_AGENT':
      return withBundle(state, action.projectId, (b) => ({
        ...b,
        agents: upsert(b.agents, action.agent),
      }));
    case 'REMOVE_AGENT':
      return withBundle(state, action.projectId, (b) => ({
        ...b,
        agents: b.agents.filter((a) => a.id !== action.agentId),
      }));
    case 'WS':
      return applyWs(state, action.message);
    case 'WS_BATCH':
      return action.messages.reduce(applyWs, state);
    case 'WS_STATUS':
      return { ...state, wsConnected: action.connected };
    case 'MARK_THREADS_SEEN': {
      const seen = { ...state.threadsSeenAt, [action.projectId]: action.at };
      try {
        localStorage.setItem(THREADS_SEEN_KEY, JSON.stringify(seen));
      } catch {
        /* ignore quota/availability errors */
      }
      return { ...state, threadsSeenAt: seen };
    }
    default:
      return state;
  }
}

interface AppContextValue {
  state: State;
  refreshProjects: () => Promise<void>;
  createProject: (input: {
    name: string;
    repoDir: string;
    defaultModel?: string;
  }) => Promise<Project>;
  deleteProject: (id: string) => Promise<void>;
  ensureBundle: (projectId: string) => Promise<void>;
  loadAgentTasks: (projectId: string, agentId: string) => Promise<void>;
  loadAgentNotes: (projectId: string, agentId: string) => Promise<void>;
  sendChat: (projectId: string, content: string) => Promise<void>;
  createWorkItem: (
    projectId: string,
    input: {
      title: string;
      description?: string;
      kind?: 'task' | 'epic';
      priority?: string;
      assigneeAgentId?: string | null;
      scheduledAt?: number;
      recurrence?: string;
    },
  ) => Promise<void>;
  updateWorkItem: (
    projectId: string,
    workItemId: string,
    input: Record<string, unknown>,
  ) => Promise<void>;
  deleteWorkItem: (workItemId: string) => Promise<void>;
  createAgent: (projectId: string, input: Record<string, unknown>) => Promise<void>;
  updateAgent: (
    projectId: string,
    agentId: string,
    input: Record<string, unknown>,
  ) => Promise<void>;
  deleteAgent: (projectId: string, agentId: string) => Promise<void>;
  answerQuestion: (questionId: string, answer: string) => Promise<void>;
  markNotificationRead: (notificationId: string) => Promise<void>;
  markAllNotificationsRead: (projectId: string) => Promise<void>;
  updateProject: (id: string, input: Record<string, unknown>) => Promise<void>;
  markThreadsSeen: (projectId: string) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [state, dispatch] = useReducer(reducer, {
    projects: [],
    projectsLoaded: false,
    bundles: {},
    wsConnected: false,
    threadsSeenAt: loadThreadsSeen(),
  });
  const stateRef = useRef(state);
  stateRef.current = state;

  // WebSocket with auto-reconnect. High-frequency frames (streaming deltas,
  // activity events) are coalesced and flushed once per animation frame so a busy
  // team can't swamp React with per-token re-renders (which made nav feel laggy).
  useEffect(() => {
    let socket: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    let buffer: ServerMessage[] = [];
    let raf = 0;

    const flush = (): void => {
      raf = 0;
      if (buffer.length === 0) return;
      const batch = buffer;
      buffer = [];
      dispatch({ type: 'WS_BATCH', messages: batch });
    };
    const schedule = (): void => {
      if (raf) return;
      raf =
        typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame(flush)
          : (setTimeout(flush, 16) as unknown as number);
    };

    const connect = (): void => {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${proto}://${window.location.host}/ws`);
      socket.onopen = () => dispatch({ type: 'WS_STATUS', connected: true });
      socket.onclose = () => {
        dispatch({ type: 'WS_STATUS', connected: false });
        if (!closed) retry = setTimeout(connect, 1000);
      };
      socket.onmessage = (ev) => {
        try {
          const raw = JSON.parse(ev.data as string) as { type?: string };
          if (!raw || typeof raw.type !== 'string' || raw.type === 'hello') return;
          buffer.push(raw as ServerMessage);
          schedule();
        } catch {
          /* ignore malformed frames */
        }
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      socket?.close();
    };
  }, []);

  const value = useMemo<AppContextValue>(() => {
    const refreshProjects = async (): Promise<void> => {
      const { projects } = await api.listProjects();
      dispatch({ type: 'SET_PROJECTS', projects });
    };

    const ensureBundle = async (projectId: string): Promise<void> => {
      const existing = stateRef.current.bundles[projectId];
      if (existing?.loaded) return;
      const [detail, chat, events] = await Promise.all([
        api.getProject(projectId),
        api.chatHistory(projectId),
        api.events(projectId),
      ]);
      dispatch({
        type: 'SET_BUNDLE',
        projectId,
        bundle: {
          agents: detail.agents,
          workItems: detail.workItems,
          questions: detail.questions,
          chat: chat.messages,
          events: events.events,
          pulls: detail.pulls,
          threads: detail.threads,
          notifications: detail.notifications,
          prComments: detail.prComments,
          loaded: true,
        },
      });
      // First time we load this project, treat existing history as already seen so
      // the Threads badge only counts messages that arrive from here on.
      if (stateRef.current.threadsSeenAt[projectId] === undefined) {
        dispatch({ type: 'MARK_THREADS_SEEN', projectId, at: Date.now() });
      }
    };

    return {
      state,
      refreshProjects,
      ensureBundle,
      createProject: async (input) => {
        const { project } = await api.createProject(input);
        dispatch({ type: 'UPSERT_PROJECT', project });
        return project;
      },
      deleteProject: async (id) => {
        await api.deleteProject(id);
        dispatch({ type: 'REMOVE_PROJECT', projectId: id });
      },
      updateProject: async (id, input) => {
        await api.updateProject(id, input);
      },
      markThreadsSeen: (projectId) => {
        dispatch({ type: 'MARK_THREADS_SEEN', projectId, at: Date.now() });
      },
      loadAgentTasks: async (projectId, agentId) => {
        const { tasks } = await api.agentTasks(agentId);
        const bundle = stateRef.current.bundles[projectId] ?? emptyBundle();
        dispatch({
          type: 'SET_BUNDLE',
          projectId,
          bundle: { tasksByAgent: { ...bundle.tasksByAgent, [agentId]: tasks } },
        });
      },
      loadAgentNotes: async (projectId, agentId) => {
        const { plan, notes } = await api.agentNotes(agentId);
        const bundle = stateRef.current.bundles[projectId] ?? emptyBundle();
        dispatch({
          type: 'SET_BUNDLE',
          projectId,
          bundle: {
            notesByAgent: { ...bundle.notesByAgent, [agentId]: notes },
            plansByAgent: { ...bundle.plansByAgent, [agentId]: plan },
          },
        });
      },
      sendChat: async (projectId, content) => {
        await api.sendChat(projectId, content);
      },
      createWorkItem: async (projectId, input) => {
        await api.createWorkItem(projectId, input as never);
      },
      updateWorkItem: async (_projectId, workItemId, input) => {
        await api.updateWorkItem(workItemId, input as never);
      },
      deleteWorkItem: async (workItemId) => {
        await api.deleteWorkItem(workItemId);
      },
      createAgent: async (projectId, input) => {
        const { agent } = await api.createAgent(projectId, input as never);
        dispatch({ type: 'UPSERT_AGENT', projectId, agent });
      },
      updateAgent: async (projectId, agentId, input) => {
        const { agent } = await api.updateAgent(agentId, input as never);
        dispatch({ type: 'UPSERT_AGENT', projectId, agent });
      },
      deleteAgent: async (projectId, agentId) => {
        await api.deleteAgent(agentId);
        dispatch({ type: 'REMOVE_AGENT', projectId, agentId });
      },
      answerQuestion: async (questionId, answer) => {
        await api.answerQuestion(questionId, answer);
      },
      markNotificationRead: async (notificationId) => {
        await api.markNotificationRead(notificationId);
        for (const [pid, b] of Object.entries(state.bundles)) {
          if (b.notifications.some((n) => n.id === notificationId)) {
            dispatch({
              type: 'SET_BUNDLE',
              projectId: pid,
              bundle: {
                notifications: b.notifications.map((n) =>
                  n.id === notificationId ? { ...n, read: true } : n,
                ),
              },
            });
            break;
          }
        }
      },
      markAllNotificationsRead: async (projectId) => {
        await api.markAllNotificationsRead(projectId);
        const b = state.bundles[projectId];
        if (b)
          dispatch({
            type: 'SET_BUNDLE',
            projectId,
            bundle: { notifications: b.notifications.map((n) => ({ ...n, read: true })) },
          });
      },
    };
  }, [state]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}

export function useBundle(projectId: string | undefined): ProjectBundle {
  const { state } = useApp();
  return (projectId ? state.bundles[projectId] : undefined) ?? emptyBundle();
}
