import React, { useEffect } from 'react';
import { NavLink, Navigate, Outlet, Route, Routes, useParams } from 'react-router-dom';
import { useApp, useBundle } from './state';
import { ProjectsPage } from './pages/ProjectsPage';
import { DashboardPage } from './pages/DashboardPage';
import { ChatPage } from './pages/ChatPage';
import { BoardPage } from './pages/BoardPage';
import { AgentsPage } from './pages/AgentsPage';
import { AgentDetailPage } from './pages/AgentDetailPage';
import { ActivityPage } from './pages/ActivityPage';
import { PullRequestsPage } from './pages/PullRequestsPage';
import { SettingsPage } from './pages/SettingsPage';
import { NotificationsPage } from './pages/NotificationsPage';

const NAV = [
  { to: 'dashboard', label: 'Dashboard', icon: '📊' },
  { to: 'chat', label: 'Chat', icon: '💬' },
  { to: 'board', label: 'Board', icon: '🗂️' },
  { to: 'agents', label: 'Agents', icon: '🤖' },
  { to: 'pulls', label: 'Pull Requests', icon: '🔃' },
  { to: 'activity', label: 'Activity', icon: '📡' },
  { to: 'notifications', label: 'Notifications', icon: '🔔' },
  { to: 'settings', label: 'Settings', icon: '⚙️' },
];

function Sidebar({ projectId }: { projectId: string }): React.JSX.Element {
  const { state } = useApp();
  const bundle = useBundle(projectId);
  const project = state.projects.find((p) => p.id === projectId);
  const working = bundle.agents.filter((a) => a.status === 'working').length;
  const needsInput = bundle.questions.filter((q) => q.status === 'pending').length;
  const unread = bundle.notifications.filter((n) => !n.read).length;

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-surface-border bg-surface-1">
      <div className="border-b border-surface-border px-4 py-4">
        <NavLink
          to="/"
          className="flex items-center gap-2 text-sm font-semibold tracking-tight text-slate-100"
        >
          <span
            className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-600/20 text-accent-400"
            aria-hidden="true"
          >
            🧭
          </span>
          <span>ateam</span>
        </NavLink>
      </div>
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
      <nav className="flex-1 space-y-0.5 p-3" aria-label="Project navigation">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={`/p/${projectId}/${item.to}`}
            className={({ isActive }) =>
              `nav-link ${isActive ? 'nav-link-active' : 'nav-link-idle'}`
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
                  <span aria-hidden="true" className="text-base">
                    {item.icon}
                  </span>{' '}
                  {item.label}
                </span>
                {item.to === 'board' && needsInput > 0 && (
                  <span className="rounded-full bg-status-input px-1.5 text-xs font-semibold text-black">
                    {needsInput}
                  </span>
                )}
                {item.to === 'notifications' && unread > 0 && (
                  <span
                    className="rounded-full bg-accent-500 px-1.5 text-xs font-semibold text-white"
                    data-testid="unread-badge"
                  >
                    {unread}
                  </span>
                )}
              </>
            )}
          </NavLink>
        ))}
      </nav>
      <div className="border-t border-surface-border p-3 text-xs text-slate-500">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${state.wsConnected ? 'bg-status-done' : 'bg-status-blocked'}`}
          />
          {state.wsConnected ? 'Live' : 'Reconnecting…'}
        </div>
        <div className="mt-1 flex items-center gap-1.5">
          {working > 0 ? (
            <>
              <span className="h-1.5 w-1.5 animate-pulseDot rounded-full bg-status-working" />
              {`${working} agent${working > 1 ? 's' : ''} working`}
            </>
          ) : (
            'All agents idle'
          )}
        </div>
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
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="pulls" element={<PullRequestsPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
