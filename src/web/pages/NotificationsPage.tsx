import React, { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Notification, NotificationType } from '@shared/index';
import { useApp, useBundle } from '../state';
import { EmptyState } from '../components/ui';

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
  const notifications = bundle.notifications;
  const unread = notifications.filter((n) => !n.read).length;

  // Visiting this page clears the unread count.
  useEffect(() => {
    if (projectId && notifications.some((n) => !n.read)) {
      void markAllNotificationsRead(projectId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, notifications.length]);

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
        {notifications.length > 0 && (
          <button
            className="btn-ghost"
            data-testid="mark-all-read"
            onClick={() => projectId && void markAllNotificationsRead(projectId)}
          >
            Mark all read
          </button>
        )}
      </header>

      <div className="p-6">
        {notifications.length === 0 ? (
          <EmptyState
            title="No notifications yet"
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
