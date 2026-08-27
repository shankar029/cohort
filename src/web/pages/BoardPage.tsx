import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Agent, WorkItem, WorkItemStatus } from '@shared/index';
import { useApp, useBundle } from '../state';
import { Avatar, Banner, Modal, UsageChip, agentAvatar } from '../components/ui';
import { usageForWorkItem } from '../usage';
import { Markdown } from '../components/Markdown';

/**
 * Deleting an epic is destructive: it removes all child tasks, stops the team,
 * and throws away the epic's isolated work (and, if it was already merged, can
 * revert the changes). Confirm first; plain tasks delete immediately.
 */
async function confirmAndDelete(
  item: WorkItem,
  del: (id: string, revert?: boolean) => Promise<void>,
): Promise<void> {
  if (item.kind !== 'epic') {
    await del(item.id);
    return;
  }
  const merged = item.status === 'done';
  const base = merged
    ? `Discard epic “${item.title}”?\n\nThis deletes the epic and all its tasks and stops the team. This epic was already merged.`
    : `Discard epic “${item.title}”?\n\nThis deletes the epic and all its tasks, stops the team, and throws away the epic’s isolated work. Your repo is not affected.`;
  if (!window.confirm(base)) return;
  let revert = false;
  if (merged) {
    revert = window.confirm(
      `Also REVERT the merged changes from your repo?\n\nOK = add a revert commit undoing the epic.\nCancel = keep the merged code, just remove the board items.`,
    );
  }
  await del(item.id, revert);
}

/**
 * Options for an assignee <select>: Unassigned, the Team Lead (who delegates the
 * item to the best-fit specialist), then the specialists themselves.
 */
function AssigneeOptions({ agents }: { agents: Agent[] }): React.JSX.Element {
  const lead = agents.find((a) => a.kind === 'lead');
  const specialists = agents.filter((a) => a.kind === 'specialist');
  return (
    <>
      <option value="">Unassigned</option>
      {lead && <option value={lead.id}>👑 {lead.displayName} (delegates)</option>}
      {specialists.map((a) => (
        <option key={a.id} value={a.id}>
          {a.emoji} {a.displayName}
        </option>
      ))}
    </>
  );
}

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
  // Detail modal open-state lives at board level (not inside a card) so it stays
  // open when an agent auto-works the item and its card moves between columns.
  const [detailId, setDetailId] = useState<string | null>(null);
  const [epicFilter, setEpicFilter] = useState<string>(
    () => (projectId && localStorage.getItem(`ateam.boardFilter.${projectId}`)) || 'all',
  );

  const epics = bundle.workItems.filter((w) => w.kind === 'epic');

  const selectFilter = (value: string): void => {
    setEpicFilter(value);
    if (projectId) localStorage.setItem(`ateam.boardFilter.${projectId}`, value);
  };

  const onDrop = (status: WorkItemStatus): void => {
    if (dragId && projectId) void updateWorkItem(projectId, dragId, { status });
    setDragId(null);
  };

  const inFilter = (w: WorkItem): boolean =>
    epicFilter === 'all' ? true : w.id === epicFilter || w.parentId === epicFilter;

  const detailItem = detailId ? bundle.workItems.find((w) => w.id === detailId) : undefined;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-surface-border px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Board</h1>
          <p className="text-sm text-slate-500">
            Create work items — the Team Lead assigns and coordinates them across the team.
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

      {epics.length > 0 && (
        <div className="flex items-center gap-2 border-b border-surface-border px-6 py-3">
          <label htmlFor="epic-filter" className="text-xs font-medium text-slate-400">
            Filter by epic
          </label>
          <select
            id="epic-filter"
            data-testid="epic-filter"
            className="input !min-h-0 max-w-md py-1 text-sm"
            value={epicFilter}
            onChange={(e) => selectFilter(e.target.value)}
          >
            <option value="all">All work</option>
            {epics.map((epic) => {
              const children = bundle.workItems.filter((w) => w.parentId === epic.id);
              const done = children.filter((c) => c.status === 'done').length;
              const suffix = children.length ? ` (${done}/${children.length})` : '';
              return (
                <option key={epic.id} value={epic.id}>
                  {epic.title}
                  {suffix}
                </option>
              );
            })}
          </select>
        </div>
      )}

      <div className="flex flex-1 gap-4 overflow-x-auto p-6" data-testid="board">
        {COLUMNS.map((col) => {
          const items = bundle.workItems.filter((w) => w.status === col.status && inFilter(w));
          return (
            <section
              key={col.status}
              className="flex w-72 shrink-0 flex-col rounded-xl border border-surface-border bg-surface-1/50"
              data-testid={`column-${col.status}`}
              aria-label={col.label}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => onDrop(col.status)}
            >
              <div className="flex items-center justify-between px-3 py-2.5">
                <h2 className="text-sm font-semibold text-slate-200">
                  {col.label}{' '}
                  <span className="ml-1 rounded-full bg-surface-2 px-1.5 text-xs text-slate-500">
                    {items.length}
                  </span>
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
                  <WorkItemCard
                    key={item.id}
                    item={item}
                    onDragStart={() => setDragId(item.id)}
                    onOpenDetail={() => setDetailId(item.id)}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {showCreate && <CreateItemModal status={showCreate} onClose={() => setShowCreate(null)} />}
      {detailItem && <WorkItemDetailModal item={detailItem} onClose={() => setDetailId(null)} />}
    </div>
  );
}

function WorkItemCard({
  item,
  onDragStart,
  onOpenDetail,
}: {
  item: WorkItem;
  onDragStart: () => void;
  onOpenDetail: () => void;
}): React.JSX.Element {
  const { projectId } = useParams<{ projectId: string }>();
  const { updateWorkItem, deleteWorkItem } = useApp();
  const bundle = useBundle(projectId);
  const assignee = bundle.agents.find((a) => a.id === item.assigneeAgentId);
  const isEpic = item.kind === 'epic';
  const parentEpic = item.parentId
    ? bundle.workItems.find((w) => w.id === item.parentId)
    : undefined;
  const childCount = isEpic ? bundle.workItems.filter((w) => w.parentId === item.id).length : 0;
  const doneChildren = isEpic
    ? bundle.workItems.filter((w) => w.parentId === item.id && w.status === 'done').length
    : 0;
  const usage = usageForWorkItem(bundle.usage, bundle.workItems, item.id);

  return (
    <>
      <div
        className={`card cursor-grab p-3 transition-shadow hover:shadow-pop active:cursor-grabbing ${
          isEpic ? 'border-l-2 border-l-accent-500 bg-surface-2/60' : ''
        }`}
        draggable
        onDragStart={onDragStart}
        data-testid="workitem"
      >
        <div className="mb-1 flex flex-wrap items-center gap-1">
          {isEpic && <span className="badge-accent">EPIC</span>}
          {item.stream && <span className="badge-muted">{item.stream}</span>}
          {parentEpic && (
            <span className="badge-muted max-w-[9rem] truncate" title={parentEpic.title}>
              ↳ {parentEpic.title}
            </span>
          )}
          {item.dependsOn.length > 0 && (
            <span className="badge-muted" title={`${item.dependsOn.length} dependencies`}>
              🔗 {item.dependsOn.length}
            </span>
          )}
        </div>
        <div className="flex items-start justify-between gap-2">
          <button
            type="button"
            className="flex-1 text-left text-sm font-medium text-slate-100 hover:text-accent-300"
            data-testid="workitem-title"
            onClick={onOpenDetail}
          >
            {item.title}
          </button>
          <button
            className="text-xs text-slate-600 hover:text-red-400"
            aria-label={isEpic ? 'Discard epic' : 'Delete work item'}
            onClick={() => void confirmAndDelete(item, deleteWorkItem)}
          >
            ✕
          </button>
        </div>
        {item.description && (
          <p className="mt-1 line-clamp-2 text-xs text-slate-500">{item.description}</p>
        )}
        {!isEpic && (item.progress > 0 || item.status === 'in_progress') && (
          <div className="mt-2">
            <div className="mb-1 flex items-center justify-between text-[0.7rem] text-slate-500">
              <span>Progress</span>
              <span>{item.progress}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
              <div
                className="h-full rounded-full bg-status-working transition-all"
                style={{ width: `${item.progress}%` }}
              />
            </div>
          </div>
        )}
        {isEpic && childCount > 0 && (
          <div className="mt-2">
            <div className="mb-1 flex items-center justify-between text-[0.7rem] text-slate-500">
              <span>Progress</span>
              <span>
                {doneChildren}/{childCount}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
              <div
                className="h-full rounded-full bg-accent-500 transition-all"
                style={{ width: `${childCount ? (doneChildren / childCount) * 100 : 0}%` }}
              />
            </div>
          </div>
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
          <div className="flex items-center gap-2">
            <UsageChip tokens={usage.tokens} timeMs={usage.timeMs} />
            {assignee && (
              <Avatar
                emoji={assignee.emoji}
                color={assignee.color}
                src={agentAvatar(assignee.catalogId, assignee.kind)}
                size={22}
              />
            )}
          </div>
        </div>
        {!isEpic && (
          <>
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
              <AssigneeOptions agents={bundle.agents} />
            </select>
          </>
        )}
      </div>
    </>
  );
}

function WorkItemDetailModal({
  item,
  onClose,
}: {
  item: WorkItem;
  onClose: () => void;
}): React.JSX.Element {
  const { projectId } = useParams<{ projectId: string }>();
  const { updateWorkItem, deleteWorkItem } = useApp();
  const bundle = useBundle(projectId);
  const assignee = bundle.agents.find((a) => a.id === item.assigneeAgentId);
  const parentEpic = item.parentId
    ? bundle.workItems.find((w) => w.id === item.parentId)
    : undefined;
  const children =
    item.kind === 'epic' ? bundle.workItems.filter((w) => w.parentId === item.id) : [];
  const deps = item.dependsOn
    .map((d) => bundle.workItems.find((w) => w.id === d))
    .filter((w): w is WorkItem => Boolean(w));
  const pr = bundle.pulls.find((p) => p.workItemId === item.id);

  const itemUsage = usageForWorkItem(bundle.usage, bundle.workItems, item.id);
  const usageIds = new Set<string>([item.id, ...children.map((c) => c.id)]);
  const usageByAgent = new Map<string, { tokens: number; timeMs: number }>();
  for (const u of bundle.usage) {
    if (!u.workItemId || !usageIds.has(u.workItemId)) continue;
    const cur = usageByAgent.get(u.agentId) ?? { tokens: 0, timeMs: 0 };
    cur.tokens += u.inputTokens + u.outputTokens;
    cur.timeMs += u.timeMs;
    usageByAgent.set(u.agentId, cur);
  }
  const usageRows = [...usageByAgent.entries()]
    .map(([agentId, u]) => ({ agent: bundle.agents.find((a) => a.id === agentId), ...u }))
    .sort((a, b) => b.tokens - a.tokens);

  const set = (patch: Record<string, unknown>): void => {
    if (projectId) void updateWorkItem(projectId, item.id, patch);
  };

  return (
    <Modal title={item.kind === 'epic' ? 'Epic details' : 'Task details'} onClose={onClose}>
      <div className="max-h-[70vh] space-y-4 overflow-auto" data-testid="workitem-detail">
        <div>
          <div className="mb-1 flex flex-wrap items-center gap-1">
            {item.kind === 'epic' && <span className="badge-accent">EPIC</span>}
            {item.stream && <span className="badge-muted">{item.stream}</span>}
            {parentEpic && <span className="badge-muted">↳ {parentEpic.title}</span>}
          </div>
          <h3 className="text-base font-semibold text-slate-100">{item.title}</h3>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="label">Status</span>
            <select
              className="input !min-h-0 py-1 text-sm"
              value={item.status}
              onChange={(e) => set({ status: e.target.value })}
            >
              {COLUMNS.map((c) => (
                <option key={c.status} value={c.status}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">Priority</span>
            <select
              className="input !min-h-0 py-1 text-sm"
              value={item.priority}
              onChange={(e) => set({ priority: e.target.value })}
            >
              {['low', 'medium', 'high'].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          {item.kind !== 'epic' && (
            <label className="col-span-2 block">
              <span className="label">Assignee</span>
              <select
                className="input !min-h-0 py-1 text-sm"
                value={item.assigneeAgentId ?? ''}
                onChange={(e) => set({ assigneeAgentId: e.target.value || null })}
              >
                <AssigneeOptions agents={bundle.agents} />
              </select>
            </label>
          )}
          {item.kind === 'epic' && (
            <div className="col-span-2">
              <span className="label">Owner</span>
              <p className="text-sm text-slate-300">
                👑 {assignee?.displayName ?? 'Team Lead'}{' '}
                <span className="text-xs text-slate-500">— epics are owned by the Team Lead</span>
              </p>
            </div>
          )}
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between text-xs text-slate-400">
            <span className="label !mb-0">Progress</span>
            <span className="font-medium text-slate-200">{item.progress}%</span>
          </div>
          <div className="mb-2 h-2 overflow-hidden rounded-full bg-surface-3">
            <div
              className="h-full rounded-full bg-status-working transition-all"
              style={{ width: `${item.progress}%` }}
            />
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={item.progress}
            className="w-full accent-accent-500"
            data-testid="progress-slider"
            onChange={(e) => set({ progress: Number(e.target.value) })}
          />
        </div>

        {(itemUsage.tokens > 0 || itemUsage.timeMs > 0) && (
          <div data-testid="usage-panel">
            <div className="mb-1 flex items-center justify-between">
              <span className="label !mb-0">Time &amp; tokens</span>
              <UsageChip
                tokens={itemUsage.tokens}
                timeMs={itemUsage.timeMs}
                title={`${itemUsage.turns} turn${itemUsage.turns === 1 ? '' : 's'} · ${itemUsage.inputTokens} in / ${itemUsage.outputTokens} out`}
              />
            </div>
            <ul className="space-y-1 rounded bg-surface-2 p-2">
              {usageRows.map((r) => (
                <li
                  key={r.agent?.id ?? 'unknown'}
                  className="flex items-center justify-between text-xs text-slate-300"
                >
                  <span className="truncate">{r.agent?.displayName ?? 'Unknown agent'}</span>
                  <UsageChip tokens={r.tokens} timeMs={r.timeMs} />
                </li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <span className="label">Description</span>
          {item.description ? (
            <div className="rounded bg-surface-2 p-2 text-sm text-slate-300">
              <Markdown content={item.description} />
            </div>
          ) : (
            <p className="text-sm text-slate-500">No description.</p>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          {assignee && (
            <DetailField label="Assignee" value={`${assignee.emoji} ${assignee.displayName}`} />
          )}
          {item.branch && <DetailField label="Branch" value={item.branch} mono />}
          {item.scheduledAt && (
            <DetailField
              label="Scheduled"
              value={`${new Date(item.scheduledAt).toLocaleString()}${
                item.recurrence !== 'none' ? ` · ${item.recurrence}` : ''
              }`}
            />
          )}
          <DetailField label="Created" value={new Date(item.createdAt).toLocaleString()} />
          <DetailField label="Updated" value={new Date(item.updatedAt).toLocaleString()} />
        </dl>

        {deps.length > 0 && (
          <div>
            <span className="label">Depends on</span>
            <ul className="space-y-1">
              {deps.map((d) => (
                <li key={d.id} className="flex items-center gap-2 text-sm text-slate-300">
                  <span className="badge-muted">{d.status}</span>
                  <span className="truncate">{d.title}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {children.length > 0 && (
          <div>
            <span className="label">Tasks ({children.length})</span>
            <ul className="space-y-1">
              {children.map((c) => (
                <li key={c.id} className="flex items-center gap-2 text-sm text-slate-300">
                  <span className="badge-muted">{c.status}</span>
                  {c.stream && <span className="badge-muted">{c.stream}</span>}
                  <span className="truncate">{c.title}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {pr && (
          <div>
            <span className="label">Pull request</span>
            <p className="text-sm text-slate-300">
              <span className="badge-muted mr-2">{pr.status}</span>
              {pr.title}
            </p>
          </div>
        )}

        <div className="flex justify-between border-t border-surface-border pt-3">
          <button
            type="button"
            className="btn-danger"
            onClick={() => {
              void confirmAndDelete(item, deleteWorkItem).then(onClose);
            }}
          >
            {item.kind === 'epic' ? 'Discard epic' : 'Delete'}
          </button>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}

function DetailField({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): React.JSX.Element {
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd className={mono ? 'font-mono text-xs text-slate-300' : 'text-slate-200'}>{value}</dd>
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
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<'task' | 'epic'>('task');
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
      if (kind === 'epic') {
        // Epics are owned + planned by the Team Lead; no manual assignee/schedule.
        await createWorkItem(projectId, { title, description, kind: 'epic', priority });
        onClose();
        return;
      }
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
        <h2 className="mb-4 text-lg font-semibold text-slate-100">
          {kind === 'epic' ? 'New epic' : 'New work item'}
        </h2>
        <div className="mb-4 inline-flex rounded-md border border-surface-border p-0.5 text-xs">
          {(['task', 'epic'] as const).map((k) => (
            <button
              key={k}
              type="button"
              data-testid={`kind-${k}`}
              onClick={() => setKind(k)}
              className={`rounded px-3 py-1 font-medium capitalize transition-colors ${
                kind === k ? 'bg-accent-500 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {k}
            </button>
          ))}
        </div>
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
            {kind === 'task' && (
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
                  <AssigneeOptions agents={bundle.agents} />
                </select>
              </div>
            )}
          </div>
          {kind === 'epic' ? (
            <p className="rounded-md bg-surface-2 px-3 py-2 text-xs text-slate-400">
              👑 The Team Lead owns this epic — it will plan the approach and break it into tasks
              across the team{' '}
              <span className="text-slate-500">(or when you resume, if the team is paused)</span>.
            </p>
          ) : (
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
          )}
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
            {busy ? 'Creating…' : kind === 'epic' ? 'Create epic' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}
