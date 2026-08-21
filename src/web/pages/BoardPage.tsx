import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import type { WorkItem, WorkItemStatus } from '@shared/index';
import { useApp, useBundle } from '../state';
import { Avatar, Banner } from '../components/ui';

const COLUMNS: { status: WorkItemStatus; label: string }[] = [
  { status: 'backlog', label: 'Backlog' },
  { status: 'todo', label: 'To Do' },
  { status: 'in_progress', label: 'In Progress' },
  { status: 'review', label: 'Review' },
  { status: 'done', label: 'Done' },
];

const PRIORITY_COLOR: Record<string, string> = {
  low: 'text-slate-400',
  medium: 'text-amber-400',
  high: 'text-red-400',
};

export function BoardPage(): React.JSX.Element {
  const { projectId } = useParams<{ projectId: string }>();
  const { updateWorkItem } = useApp();
  const bundle = useBundle(projectId);
  const [showCreate, setShowCreate] = useState<WorkItemStatus | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const onDrop = (status: WorkItemStatus): void => {
    if (dragId && projectId) void updateWorkItem(projectId, dragId, { status });
    setDragId(null);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-surface-border px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Board</h1>
          <p className="text-sm text-slate-500">
            Create work items and assign them to an agent — assigned agents pick them up
            automatically.
          </p>
        </div>
        <button
          className="btn-primary"
          data-testid="add-workitem"
          onClick={() => setShowCreate('todo')}
        >
          ＋ New work item
        </button>
      </header>

      <div className="flex flex-1 gap-4 overflow-x-auto p-6" data-testid="board">
        {COLUMNS.map((col) => {
          const items = bundle.workItems.filter((w) => w.status === col.status);
          return (
            <section
              key={col.status}
              className="flex w-72 shrink-0 flex-col rounded-lg bg-surface-1/60"
              data-testid={`column-${col.status}`}
              aria-label={col.label}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => onDrop(col.status)}
            >
              <div className="flex items-center justify-between px-3 py-2">
                <h2 className="text-sm font-semibold text-slate-200">
                  {col.label} <span className="text-slate-500">{items.length}</span>
                </h2>
                <button
                  className="btn-ghost !min-h-0 px-2 py-1 text-xs"
                  aria-label={`Add item to ${col.label}`}
                  onClick={() => setShowCreate(col.status)}
                >
                  ＋
                </button>
              </div>
              <div className="flex-1 space-y-2 overflow-y-auto px-2 pb-2">
                {items.length === 0 && (
                  <p className="px-2 py-6 text-center text-xs text-slate-600">Nothing here</p>
                )}
                {items.map((item) => (
                  <WorkItemCard key={item.id} item={item} onDragStart={() => setDragId(item.id)} />
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {showCreate && <CreateItemModal status={showCreate} onClose={() => setShowCreate(null)} />}
    </div>
  );
}

function WorkItemCard({
  item,
  onDragStart,
}: {
  item: WorkItem;
  onDragStart: () => void;
}): React.JSX.Element {
  const { projectId } = useParams<{ projectId: string }>();
  const { updateWorkItem, deleteWorkItem } = useApp();
  const bundle = useBundle(projectId);
  const assignee = bundle.agents.find((a) => a.id === item.assigneeAgentId);
  const specialists = bundle.agents.filter((a) => a.kind === 'specialist');

  return (
    <div
      className="card cursor-grab p-3 active:cursor-grabbing"
      draggable
      onDragStart={onDragStart}
      data-testid="workitem"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-slate-100">{item.title}</p>
        <button
          className="text-xs text-slate-600 hover:text-red-400"
          aria-label="Delete work item"
          onClick={() => void deleteWorkItem(item.id)}
        >
          ✕
        </button>
      </div>
      {item.description && (
        <p className="mt-1 line-clamp-2 text-xs text-slate-500">{item.description}</p>
      )}
      {item.scheduledAt && item.status === 'backlog' && (
        <p className="mt-1 text-xs text-cyan-300">
          ⏰ {new Date(item.scheduledAt).toLocaleString()}
          {item.recurrence !== 'none' && ` · ${item.recurrence}`}
        </p>
      )}
      <div className="mt-2 flex items-center justify-between">
        <span className={`text-xs font-medium ${PRIORITY_COLOR[item.priority]}`}>
          ● {item.priority}
        </span>
        {assignee && <Avatar emoji={assignee.emoji} color={assignee.color} size={22} />}
      </div>
      <label className="sr-only" htmlFor={`assign-${item.id}`}>
        Assign agent
      </label>
      <select
        id={`assign-${item.id}`}
        className="input mt-2 !min-h-0 py-1 text-xs"
        data-testid="assign-select"
        value={item.assigneeAgentId ?? ''}
        onChange={(e) =>
          projectId &&
          void updateWorkItem(projectId, item.id, { assigneeAgentId: e.target.value || null })
        }
      >
        <option value="">Unassigned</option>
        {specialists.map((a) => (
          <option key={a.id} value={a.id}>
            {a.emoji} {a.displayName}
          </option>
        ))}
      </select>
    </div>
  );
}

function CreateItemModal({
  status,
  onClose,
}: {
  status: WorkItemStatus;
  onClose: () => void;
}): React.JSX.Element {
  const { projectId } = useParams<{ projectId: string }>();
  const { createWorkItem } = useApp();
  const bundle = useBundle(projectId);
  const specialists = bundle.agents.filter((a) => a.kind === 'specialist');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('medium');
  const [assignee, setAssignee] = useState('');
  const [scheduleAt, setScheduleAt] = useState('');
  const [recurrence, setRecurrence] = useState('none');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      const scheduledAt = scheduleAt ? new Date(scheduleAt).getTime() : undefined;
      await createWorkItem(projectId, {
        title,
        description,
        priority,
        assigneeAgentId: assignee || null,
        ...(scheduledAt && scheduledAt > Date.now() ? { scheduledAt } : {}),
        ...(scheduledAt && recurrence !== 'none' ? { recurrence } : {}),
        ...({ status } as object),
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create');
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="New work item"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <form className="card w-full max-w-lg p-5" onSubmit={submit}>
        <h2 className="mb-4 text-lg font-semibold text-slate-100">New work item</h2>
        <div className="space-y-3">
          <div>
            <label className="label" htmlFor="wi-title">
              Title
            </label>
            <input
              id="wi-title"
              className="input"
              data-testid="workitem-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div>
            <label className="label" htmlFor="wi-desc">
              Description
            </label>
            <textarea
              id="wi-desc"
              className="input"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="wi-priority">
                Priority
              </label>
              <select
                id="wi-priority"
                className="input"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="wi-assignee">
                Assign to
              </label>
              <select
                id="wi-assignee"
                className="input"
                data-testid="workitem-assignee"
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
              >
                <option value="">Unassigned</option>
                {specialists.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.emoji} {a.displayName}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="wi-schedule">
                Schedule (optional)
              </label>
              <input
                id="wi-schedule"
                type="datetime-local"
                className="input"
                data-testid="workitem-schedule"
                value={scheduleAt}
                onChange={(e) => setScheduleAt(e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="wi-recurrence">
                Repeat
              </label>
              <select
                id="wi-recurrence"
                className="input"
                value={recurrence}
                onChange={(e) => setRecurrence(e.target.value)}
                disabled={!scheduleAt}
              >
                <option value="none">Once</option>
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </div>
          </div>
          {error && <Banner kind="error">{error}</Banner>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn-primary"
            data-testid="workitem-submit"
            disabled={busy}
          >
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}
