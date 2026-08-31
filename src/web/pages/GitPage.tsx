import React, { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type {
  EpicGit,
  GitFileChange,
  GitSnapshot,
  PrComment,
  PrStatus,
  PullRequest,
  WorkItemStatus,
} from '@shared/index';
import { api } from '../api';
import { useBundle } from '../state';
import { EmptyState } from '../components/ui';

/** A titled section that collapses to just its header (with a count + chevron). */
function Collapsible({
  title,
  count,
  defaultOpen,
  testId,
  children,
}: {
  title: string;
  count: number;
  defaultOpen: boolean;
  testId?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-surface-border" data-testid={testId}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-xs font-medium text-slate-400 hover:text-slate-200"
        aria-expanded={open}
      >
        <span aria-hidden="true" className="text-[0.6rem] text-slate-500">
          {open ? '▼' : '▶'}
        </span>
        <span>{title}</span>
        <span className="rounded-full bg-surface-3 px-1.5 text-slate-500">{count}</span>
      </button>
      {open && <div className="px-4 pb-3">{children}</div>}
    </div>
  );
}

const PR_STYLE: Record<PrStatus, { label: string; cls: string }> = {
  open: { label: 'Open', cls: 'bg-blue-500/15 text-blue-300' },
  changes_requested: { label: 'Changes requested', cls: 'bg-amber-500/15 text-amber-300' },
  approved: { label: 'Approved', cls: 'bg-emerald-500/15 text-emerald-300' },
  merged: { label: 'Merged', cls: 'bg-fuchsia-500/15 text-fuchsia-300' },
};

const EPIC_STYLE: Record<WorkItemStatus, string> = {
  backlog: 'bg-slate-500/15 text-slate-300',
  todo: 'bg-slate-500/15 text-slate-300',
  in_progress: 'bg-blue-500/15 text-blue-300',
  review: 'bg-amber-500/15 text-amber-300',
  done: 'bg-emerald-500/15 text-emerald-300',
};

function fileStat(f: GitFileChange): string {
  return f.added < 0 || f.removed < 0 ? 'bin' : `+${f.added} / −${f.removed}`;
}

export function GitPage(): React.JSX.Element {
  const { projectId } = useParams<{ projectId: string }>();
  const bundle = useBundle(projectId);
  const [snapshot, setSnapshot] = useState<GitSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [epicFilter, setEpicFilter] = useState<string>('');
  const nameById = new Map(bundle.agents.map((a) => [a.id, `${a.emoji} ${a.displayName}`]));

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const res = await api.gitSnapshot(projectId);
      setSnapshot(res.snapshot);
    } catch {
      setSnapshot(null);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Refetch when git-affecting state changes (a PR opened/updated, a task landed).
  const pulseKey = `${bundle.pulls.length}:${bundle.pulls.map((p) => p.status).join(',')}:${bundle.workItems.length}`;
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pulseKey]);

  const allEpics = snapshot?.epics ?? [];
  const epics = epicFilter ? allEpics.filter((e) => e.epicId === epicFilter) : allEpics;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start justify-between gap-3 border-b border-surface-border px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Git</h1>
          <p className="text-sm text-slate-500">
            Every epic gets its own branch and isolated worktree. Agents commit their tasks onto the
            epic branch, then it&apos;s reviewed and merged into{' '}
            <span className="font-mono">{snapshot?.baseBranch ?? 'main'}</span>.
          </p>
        </div>
        <button className="btn-ghost shrink-0 text-xs" onClick={() => void load()}>
          ↻ Refresh
        </button>
      </header>

      {allEpics.length > 1 && (
        <div className="flex items-center gap-2 border-b border-surface-border px-6 py-2">
          <label className="text-xs text-slate-500" htmlFor="git-epic-filter">
            Epic
          </label>
          <select
            id="git-epic-filter"
            className="input !min-h-0 w-64 py-1 text-xs"
            data-testid="git-epic-filter"
            value={epicFilter}
            onChange={(e) => setEpicFilter(e.target.value)}
          >
            <option value="">All epics</option>
            {allEpics.map((ep) => (
              <option key={ep.epicId} value={ep.epicId}>
                {ep.title}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="flex-1 overflow-auto px-6 py-4" data-testid="git-list">
        {epics.length === 0 ? (
          <EmptyState
            title={loading ? 'Loading git activity…' : 'No git activity yet'}
            hint="Ask the Team Lead to build something — each epic opens a branch and worktree here."
          />
        ) : (
          <ul className="space-y-4">
            {epics.map((epic) => (
              <EpicGitCard
                key={epic.epicId}
                epic={epic}
                pr={bundle.pulls.find((p) => p.id === epic.prId) ?? null}
                comments={bundle.prComments.filter((c) => c.prId === epic.prId)}
                nameById={nameById}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function EpicGitCard({
  epic,
  pr,
  comments,
  nameById,
}: {
  epic: EpicGit;
  pr: PullRequest | null;
  comments: PrComment[];
  nameById: Map<string, string>;
}): React.JSX.Element {
  const [showDiff, setShowDiff] = useState(false);
  const openCount = comments.filter((c) => c.status === 'open').length;

  return (
    <li className="rounded-lg border border-surface-border bg-surface-1" data-testid="git-epic">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${EPIC_STYLE[epic.status]}`}>
          {epic.status.replace('_', ' ')}
        </span>
        <h2 className="text-sm font-semibold text-slate-100">{epic.title}</h2>
        {pr && (
          <span
            className={`ml-auto rounded px-2 py-0.5 text-xs font-medium ${PR_STYLE[pr.status].cls}`}
            data-testid="pr-card"
          >
            PR · {PR_STYLE[pr.status].label}
          </span>
        )}
      </div>

      {/* Branch / worktree */}
      <div className="border-t border-surface-border px-4 py-2 font-mono text-xs text-slate-400">
        <span className="text-slate-300">{epic.branch ?? '(no branch)'}</span> → {epic.baseBranch}
        <span className="ml-2 text-slate-500">
          {epic.worktreeActive ? '· worktree active' : '· merged (worktree reclaimed)'}
        </span>
        {epic.worktreePath && (
          <div className="mt-0.5 truncate text-[11px] text-slate-600" title={epic.worktreePath}>
            {epic.worktreePath}
          </div>
        )}
      </div>

      {/* Summary counts */}
      <div className="flex flex-wrap gap-4 px-4 py-2 text-xs text-slate-400">
        <span>
          <span className="font-semibold text-slate-200">{epic.commits.length}</span> commit
          {epic.commits.length === 1 ? '' : 's'}
        </span>
        <span>
          <span className="font-semibold text-slate-200">{epic.files.length}</span> file
          {epic.files.length === 1 ? '' : 's'} changed
        </span>
        <span>
          <span className="font-semibold text-slate-200">{epic.tasks.length}</span> task
          {epic.tasks.length === 1 ? '' : 's'}
        </span>
      </div>

      {/* Commits */}
      {epic.commits.length > 0 && (
        <Collapsible
          title="Commits on this branch"
          count={epic.commits.length}
          defaultOpen={epic.commits.length <= 8}
          testId="git-commits"
        >
          <ul className="space-y-1">
            {epic.commits.map((c) => (
              <li key={c.hash} className="flex items-baseline gap-2 text-xs">
                <span className="shrink-0 font-mono text-fuchsia-300">{c.hash.slice(0, 8)}</span>
                <span className="text-slate-300">{c.subject}</span>
                <span className="ml-auto shrink-0 text-slate-600">{c.author}</span>
              </li>
            ))}
          </ul>
        </Collapsible>
      )}

      {/* Files */}
      {epic.files.length > 0 && (
        <Collapsible
          title="Files changed"
          count={epic.files.length}
          defaultOpen={epic.files.length <= 12}
          testId="git-files"
        >
          <ul className="space-y-0.5 font-mono text-xs">
            {epic.files.map((f) => (
              <li key={f.path} className="flex items-baseline justify-between gap-3">
                <span className="truncate text-slate-300">{f.path}</span>
                <span className="shrink-0 text-slate-500">{fileStat(f)}</span>
              </li>
            ))}
          </ul>
        </Collapsible>
      )}

      {/* Tasks */}
      {epic.tasks.length > 0 && (
        <Collapsible title="Tasks" count={epic.tasks.length} defaultOpen={epic.tasks.length <= 12}>
          <ul className="space-y-1">
            {epic.tasks.map((t) => (
              <li key={t.id} className="flex items-center gap-2 text-xs">
                {t.stream && (
                  <span className="shrink-0 rounded bg-surface-3 px-1.5 py-0.5 text-slate-400">
                    {t.stream}
                  </span>
                )}
                <span className="truncate text-slate-300">{t.title}</span>
                <span className="ml-auto shrink-0 text-slate-500">
                  {t.assigneeAgentId ? nameById.get(t.assigneeAgentId) : 'unassigned'} ·{' '}
                  {t.status.replace('_', ' ')}
                </span>
              </li>
            ))}
          </ul>
        </Collapsible>
      )}

      {/* PR review comments */}
      {comments.length > 0 && (
        <Collapsible
          title={`Review comments · ${comments.length - openCount}/${comments.length} resolved`}
          count={comments.length}
          defaultOpen={comments.length <= 8}
          testId="pr-comments"
        >
          <ul className="space-y-1.5">
            {comments.map((c) => (
              <li key={c.id} className="flex items-start gap-2 text-xs" data-testid="pr-comment">
                <span
                  className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 font-medium ${
                    c.status === 'resolved'
                      ? 'bg-emerald-500/15 text-emerald-300'
                      : 'bg-amber-500/15 text-amber-300'
                  }`}
                >
                  {c.status === 'resolved' ? '✓ resolved' : 'open'}
                </span>
                {c.targetStream && (
                  <span className="mt-0.5 shrink-0 rounded bg-surface-3 px-1.5 py-0.5 text-slate-400">
                    {c.targetStream}
                  </span>
                )}
                <span className="text-slate-300">{c.body}</span>
              </li>
            ))}
          </ul>
        </Collapsible>
      )}

      {/* PR diff */}
      {pr?.diff && (
        <div className="border-t border-surface-border px-4 py-2">
          <button className="btn-ghost text-xs" onClick={() => setShowDiff((v) => !v)}>
            {showDiff ? 'Hide diff' : 'View diff'}
          </button>
          {showDiff && (
            <pre
              className="mt-2 max-h-96 overflow-auto rounded bg-surface-2 px-4 py-3 font-mono text-xs text-slate-300"
              data-testid="pr-diff"
            >
              {pr.diff}
            </pre>
          )}
        </div>
      )}
    </li>
  );
}
