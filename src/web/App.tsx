import React, { useEffect, useState } from 'react';
import { NavLink, Navigate, Outlet, Route, Routes, useParams } from 'react-router-dom';
import {
  LayoutDashboard,
  MessagesSquare,
  KanbanSquare,
  Bot,
  GitBranch,
  Radio,
  ScrollText,
  Bell,
  Settings,
  Pause,
  Play,
  PanelLeftClose,
  PanelLeft,
  type LucideIcon,
} from 'lucide-react';
import { useApp, useBundle } from './state';
import { api } from './api';
import { ThemeToggle } from './components/ui';
import { ProjectsPage } from './pages/ProjectsPage';
import { DashboardPage } from './pages/DashboardPage';
import { ChatPage } from './pages/ChatPage';
import { BoardPage } from './pages/BoardPage';
import { AgentsPage } from './pages/AgentsPage';
import { AgentDetailPage } from './pages/AgentDetailPage';
import { ActivityPage } from './pages/ActivityPage';
import { RecordingsPage } from './pages/RecordingsPage';
import { GitPage } from './pages/GitPage';
import { SettingsPage } from './pages/SettingsPage';
import { NotificationsPage } from './pages/NotificationsPage';

const NAV: { to: string; label: string; icon: LucideIcon }[] = [
  { to: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: 'chat', label: 'Threads', icon: MessagesSquare },
  { to: 'board', label: 'Board', icon: KanbanSquare },
  { to: 'agents', label: 'Agents', icon: Bot },
  { to: 'git', label: 'Git', icon: GitBranch },
  { to: 'activity', label: 'Activity', icon: Radio },
  { to: 'recordings', label: 'Recordings', icon: ScrollText },
  { to: 'notifications', label: 'Notifications', icon: Bell },
  { to: 'settings', label: 'Settings', icon: Settings },
];

function Sidebar({ projectId }: { projectId: string }): React.JSX.Element {
  const { state } = useApp();
  const bundle = useBundle(projectId);
  const project = state.projects.find((p) => p.id === projectId);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('ateam:navCollapsed') === '1',
  );
  const toggleCollapsed = (): void =>
    setCollapsed((v) => {
      const next = !v;
      try {
        localStorage.setItem('ateam:navCollapsed', next ? '1' : '0');
      } catch {
        /* ignore quota/availability */
      }
      return next;
    });
  const working = bundle.agents.filter((a) => a.status === 'working').length;
  const needsInput = bundle.questions.filter((q) => q.status === 'pending').length;
  const unread = bundle.notifications.filter((n) => !n.read).length;
  const threadsSeen = state.threadsSeenAt[projectId] ?? 0;
  const unreadThreads = bundle.chat.filter(
    (m) => m.role === 'agent' && new Date(m.createdAt).getTime() > threadsSeen,
  ).length;
  const paused = project?.settings.paused === true;
  const [pauseBusy, setPauseBusy] = useState(false);
  const togglePause = async (): Promise<void> => {
    setPauseBusy(true);
    try {
      await (paused ? api.resumeProject(projectId) : api.pauseProject(projectId));
    } finally {
      setPauseBusy(false);
    }
  };

  return (
    <aside
      className={`flex h-full shrink-0 flex-col border-r border-surface-border bg-surface-1 transition-[width] duration-150 ${
        collapsed ? 'w-16' : 'w-64'
      }`}
    >
      <div
        className={`flex items-center border-b border-surface-border py-4 ${
          collapsed ? 'justify-center px-2' : 'justify-between px-4'
        }`}
      >
        <NavLink
          to="/"
          className="flex items-center gap-2 text-sm font-semibold tracking-tight text-slate-100"
          title="A Team"
        >
          <span
            className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-lg"
            style={{ background: 'linear-gradient(145deg,#2b2b3f,#12121d)' }}
            aria-hidden="true"
          >
            <img src="/brand/mark.png" alt="" className="h-full w-full object-contain" />
          </span>
          {!collapsed && <span>A Team</span>}
        </NavLink>
        {!collapsed && (
          <button
            type="button"
            onClick={toggleCollapsed}
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
            data-testid="nav-collapse"
            className="rounded-md p-1 text-slate-500 hover:bg-surface-2 hover:text-slate-200"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        )}
      </div>
      {collapsed && (
        <button
          type="button"
          onClick={toggleCollapsed}
          title="Expand sidebar"
          aria-label="Expand sidebar"
          data-testid="nav-expand"
          className="mx-auto mt-2 rounded-md p-1.5 text-slate-500 hover:bg-surface-2 hover:text-slate-200"
        >
          <PanelLeft className="h-4 w-4" />
        </button>
      )}
      {!collapsed && (
        <div className="border-b border-surface-border p-3">
          <label className="label" htmlFor="project-switch">
            Project
          </label>
          <select
            id="project-switch"
            className="input"
            value={projectId}
            onChange={(e) => {
              window.location.href = `/p/${e.target.value}/chat`;
            }}
          >
            {state.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {project && (
            <p className="mt-2 truncate text-xs text-slate-500" title={project.repoDir}>
              {project.repoDir}
            </p>
          )}
        </div>
      )}
      <nav
        className={`flex-1 space-y-0.5 p-3 ${collapsed ? 'px-2' : ''}`}
        aria-label="Project navigation"
      >
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={`/p/${projectId}/${item.to}`}
            title={collapsed ? item.label : undefined}
            className={({ isActive }) =>
              `nav-link ${isActive ? 'nav-link-active' : 'nav-link-idle'} ${
                collapsed ? 'justify-center' : ''
              }`
            }
          >
            {({ isActive }) => (
              <>
                {isActive && (
                  <span
                    className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent-500"
                    aria-hidden="true"
                  />
                )}
                <span className="flex items-center gap-2.5">
                  <item.icon aria-hidden="true" className="h-[1.05rem] w-[1.05rem] shrink-0" />{' '}
                  {!collapsed && item.label}
                </span>
                {item.to === 'board' && needsInput > 0 && (
                  <span
                    className={`rounded-full bg-status-input text-xs font-semibold text-black ${
                      collapsed ? 'absolute right-1 top-1 h-2 w-2 p-0' : 'px-1.5'
                    }`}
                  >
                    {!collapsed && needsInput}
                  </span>
                )}
                {item.to === 'chat' && unreadThreads > 0 && (
                  <span
                    className={`rounded-full bg-accent-500 text-xs font-semibold text-white ${
                      collapsed ? 'absolute right-1 top-1 h-2 w-2 p-0' : 'px-1.5'
                    }`}
                    data-testid="unread-threads-badge"
                  >
                    {!collapsed && (unreadThreads > 99 ? '99+' : unreadThreads)}
                  </span>
                )}
                {item.to === 'notifications' && unread > 0 && (
                  <span
                    className={`rounded-full bg-accent-500 text-xs font-semibold text-white ${
                      collapsed ? 'absolute right-1 top-1 h-2 w-2 p-0' : 'px-1.5'
                    }`}
                    data-testid="unread-badge"
                  >
                    {!collapsed && unread}
                  </span>
                )}
              </>
            )}
          </NavLink>
        ))}
      </nav>
      <div className="border-t border-surface-border p-3 text-xs text-slate-500">
        <button
          type="button"
          onClick={() => void togglePause()}
          disabled={pauseBusy}
          data-testid="pause-toggle"
          className={`mb-3 flex w-full items-center justify-center gap-2 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors disabled:opacity-60 ${
            paused
              ? 'border-status-working/40 bg-status-working/10 text-status-working hover:bg-status-working/20'
              : 'border-surface-border text-slate-300 hover:bg-surface-2'
          }`}
          title={paused ? 'Resume the team' : 'Pause the team to change direction'}
        >
          {paused ? (
            <>
              <Play className="h-3.5 w-3.5" /> {!collapsed && 'Resume team'}
            </>
          ) : (
            <>
              <Pause className="h-3.5 w-3.5" /> {!collapsed && 'Pause team'}
            </>
          )}
        </button>
        {collapsed ? (
          <div className="flex flex-col items-center gap-2">
            <span
              title={state.wsConnected ? 'Live' : 'Reconnecting…'}
              className={`h-2 w-2 rounded-full ${state.wsConnected ? 'bg-status-done' : 'bg-status-blocked'}`}
            />
            <ThemeToggle />
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span
                  className={`h-2 w-2 rounded-full ${state.wsConnected ? 'bg-status-done' : 'bg-status-blocked'}`}
                />
                {state.wsConnected ? 'Live' : 'Reconnecting…'}
              </div>
              <div className="mt-1 flex items-center gap-1.5">
                {paused ? (
                  <span className="text-status-working">Paused — no new work</span>
                ) : working > 0 ? (
                  <>
                    <span className="h-1.5 w-1.5 animate-pulseDot rounded-full bg-status-working" />
                    {`${working} agent${working > 1 ? 's' : ''} working`}
                  </>
                ) : (
                  'All agents idle'
                )}
              </div>
            </div>
            <ThemeToggle />
          </div>
        )}
      </div>
    </aside>
  );
}

function ProjectLayout(): React.JSX.Element {
  const { projectId } = useParams<{ projectId: string }>();
  const { ensureBundle, state } = useApp();

  useEffect(() => {
    if (projectId) void ensureBundle(projectId);
  }, [projectId, ensureBundle]);

  if (!projectId) return <Navigate to="/" replace />;
  if (state.projectsLoaded && !state.projects.some((p) => p.id === projectId)) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="flex h-full">
      <Sidebar projectId={projectId} />
      <main className="min-w-0 flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}

export function App(): React.JSX.Element {
  const { refreshProjects } = useApp();
  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  return (
    <Routes>
      <Route path="/" element={<ProjectsPage />} />
      <Route path="/p/:projectId" element={<ProjectLayout />}>
        <Route index element={<Navigate to="dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="chat" element={<ChatPage />} />
        <Route path="board" element={<BoardPage />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="agents/:agentId" element={<AgentDetailPage />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route path="recordings" element={<RecordingsPage />} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="git" element={<GitPage />} />
        <Route path="pulls" element={<Navigate to="../git" replace />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
