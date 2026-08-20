import React, { useEffect } from 'react';
import { NavLink, Navigate, Outlet, Route, Routes, useParams } from 'react-router-dom';
import { useApp, useBundle } from './state';
import { ProjectsPage } from './pages/ProjectsPage';
import { ChatPage } from './pages/ChatPage';
import { BoardPage } from './pages/BoardPage';
import { AgentsPage } from './pages/AgentsPage';
import { AgentDetailPage } from './pages/AgentDetailPage';
import { ActivityPage } from './pages/ActivityPage';
import { SettingsPage } from './pages/SettingsPage';

const NAV = [
  { to: 'chat', label: 'Chat', icon: '💬' },
  { to: 'board', label: 'Board', icon: '🗂️' },
  { to: 'agents', label: 'Agents', icon: '🤖' },
  { to: 'activity', label: 'Activity', icon: '📡' },
  { to: 'settings', label: 'Settings', icon: '⚙️' },
];

function Sidebar({ projectId }: { projectId: string }): React.JSX.Element {
  const { state } = useApp();
  const bundle = useBundle(projectId);
  const project = state.projects.find((p) => p.id === projectId);
  const working = bundle.agents.filter((a) => a.status === 'working').length;
  const needsInput = bundle.questions.filter((q) => q.status === 'pending').length;

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-surface-border bg-surface-1">
      <div className="border-b border-surface-border p-4">
        <NavLink to="/" className="flex items-center gap-2 text-sm font-semibold text-slate-100">
          <span aria-hidden="true">🧭</span> ateam
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
      <nav className="flex-1 space-y-1 p-3" aria-label="Project navigation">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={`/p/${projectId}/${item.to}`}
            className={({ isActive }) =>
              `flex items-center justify-between rounded-md px-3 py-2 text-sm ${
                isActive ? 'bg-surface-3 text-white' : 'text-slate-300 hover:bg-surface-2'
              }`
            }
          >
            <span className="flex items-center gap-2">
              <span aria-hidden="true">{item.icon}</span> {item.label}
            </span>
            {item.to === 'board' && needsInput > 0 && (
              <span className="rounded-full bg-status-input px-1.5 text-xs font-semibold text-black">
                {needsInput}
              </span>
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
        <div className="mt-1">
          {working > 0 ? `${working} agent${working > 1 ? 's' : ''} working` : 'All agents idle'}
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
        <Route index element={<Navigate to="chat" replace />} />
        <Route path="chat" element={<ChatPage />} />
        <Route path="board" element={<BoardPage />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="agents/:agentId" element={<AgentDetailPage />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
