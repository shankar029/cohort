import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Notification, NotificationType } from '@shared/index';
import { useApp, useBundle } from '../state';
import { EmptyState } from '../components/ui';
import { epicOfWorkItem, listEpics } from '../epics';

const TYPE_META: Record<NotificationType, { icon: string; tint: string }> = {
  epic: { icon: '🎯', tint: 'text-accent-400' },
  plan: { icon: '📋', tint: 'text-accent-400' },
  progress: { icon: '📈', tint: 'text-sky-400' },
  task: { icon: '✅', tint: 'text-status-done' },
  pr: { icon: '🔃', tint: 'text-violet-400' },
  review: { icon: '🔎', tint: 'text-amber-400' },
  merge: { icon: '🎉', tint: 'text-status-done' },
  question: { icon: '❓', tint: 'text-status-input' },
  system: { icon: '🔔', tint: 'text-slate-400' },
};

export function NotificationsPage(): React.JSX.Element {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { markNotificationRead, markAllNotificationsRead } = useApp();
  const bundle = useBundle(projectId);
  const allNotifications = bundle.notifications;
  const unread = allNotifications.filter((n) => !n.read).length;
  const [epicFilter, setEpicFilter] = useState<string>('');
  const wiById = useMemo(() => new Map(bundle.workItems.map((w) => [w.id, w])), [bundle.workItems]);
  const epics = useMemo(() => listEpics(bundle.workItems), [bundle.workItems]);
  const notifications = allNotifications.filter((n) => {
    if (!epicFilter) return true;
    const epic = epicOfWorkItem(wiById, n.workItemId);
    return epicFilter === 'none' ? !epic : epic?.id === epicFilter;
  });

  // Visiting this page clears the unread count.
  useEffect(() => {
    if (projectId && allNotifications.some((n) => !n.read)) {
      void markAllNotificationsRead(projectId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, allNotifications.length]);

  const open = (n: Notification): void => {
    if (!n.read) void markNotificationRead(n.id);
    navigate(`/p/${projectId}/${n.link || 'chat'}`);
  };

  return (
    <div className="h-full overflow-auto animate-fadeIn">
      <header className="flex items-center justify-between border-b border-surface-border px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Notifications</h1>
          <p className="text-sm text-slate-500">
            {unread > 0 ? `${unread} unread` : 'All caught up'}
          </p>
        </div>
        {allNotifications.length > 0 && (
          <div className="flex items-center gap-2">
            {epics.length > 0 && (
              <select
                className="input !min-h-0 w-44 py-1 text-xs"
                data-testid="notification-epic-filter"
                value={epicFilter}
                onChange={(e) => setEpicFilter(e.target.value)}
              >
                <option value="">All epics</option>
                {epics.map((ep) => (
                  <option key={ep.id} value={ep.id}>
                    {ep.title}
                  </option>
                ))}
                <option value="none">No epic</option>
              </select>
            )}
            <button
              className="btn-ghost"
              data-testid="mark-all-read"
              onClick={() => projectId && void markAllNotificationsRead(projectId)}
            >
              Mark all read
            </button>
          </div>
        )}
      </header>

      <div className="p-6">
        {notifications.length === 0 ? (
          <EmptyState
            title={epicFilter ? 'No notifications for this epic' : 'No notifications yet'}
            hint="Major progress updates — epics, plans, completed tasks, PRs, and merges — show up here."
          />
        ) : (
          <ul className="space-y-2" data-testid="notification-list">
            {notifications.map((n) => {
              const meta = TYPE_META[n.type] ?? TYPE_META.system;
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => open(n)}
                    data-testid="notification-item"
                    className={`card flex w-full items-start gap-3 p-3 text-left transition-shadow hover:shadow-pop ${
                      n.read ? 'opacity-60' : 'border-l-2 border-l-accent-500'
                    }`}
                  >
                    <span className={`text-lg ${meta.tint}`} aria-hidden="true">
                      {meta.icon}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-medium text-slate-100">{n.title}</p>
                        {!n.read && (
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-500" />
                        )}
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-xs text-slate-400">{n.body}</p>
                    </div>
                    <span className="shrink-0 text-xs text-slate-600">
                      {new Date(n.createdAt).toLocaleString()}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
