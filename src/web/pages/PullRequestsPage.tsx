import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import type { PrStatus, PullRequest } from '@shared/index';
import { useBundle } from '../state';
import { EmptyState } from '../components/ui';

const STATUS_STYLE: Record<PrStatus, { label: string; cls: string }> = {
  open: { label: 'Open', cls: 'bg-blue-500/15 text-blue-300' },
  changes_requested: { label: 'Changes requested', cls: 'bg-amber-500/15 text-amber-300' },
  approved: { label: 'Approved', cls: 'bg-emerald-500/15 text-emerald-300' },
  merged: { label: 'Merged', cls: 'bg-fuchsia-500/15 text-fuchsia-300' },
};

export function PullRequestsPage(): React.JSX.Element {
  const { projectId } = useParams<{ projectId: string }>();
  const bundle = useBundle(projectId);
  const nameById = new Map(bundle.agents.map((a) => [a.id, `${a.emoji} ${a.displayName}`]));
  const pulls = bundle.pulls.slice().reverse();

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-surface-border px-6 py-4">
        <h1 className="text-lg font-semibold text-slate-100">Pull Requests</h1>
        <p className="text-sm text-slate-500">
          Each epic is developed on its own branch, reviewed by a teammate, and merged once it meets
          the quality bar.
        </p>
      </header>

      <div className="flex-1 overflow-auto px-6 py-4" data-testid="pr-list">
        {pulls.length === 0 ? (
          <EmptyState
            title="No pull requests yet"
            hint="Ask the Team Lead to build something — completed epics raise a PR here."
          />
        ) : (
          <ul className="space-y-3">
            {pulls.map((pr) => (
              <PrCard
                key={pr.id}
                pr={pr}
                author={pr.authorAgentId ? nameById.get(pr.authorAgentId) : '🧭 Team Lead'}
                reviewer={pr.reviewerAgentId ? nameById.get(pr.reviewerAgentId) : undefined}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function PrCard({
  pr,
  author,
  reviewer,
}: {
  pr: PullRequest;
  author?: string;
  reviewer?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const style = STATUS_STYLE[pr.status];
  return (
    <li className="rounded-lg border border-surface-border bg-surface-1" data-testid="pr-card">
      <div className="flex items-start justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`rounded px-2 py-0.5 text-xs font-medium ${style.cls}`}>
              {style.label}
            </span>
            <h2 className="truncate text-sm font-semibold text-slate-100">{pr.title}</h2>
          </div>
          <p className="mt-1 font-mono text-xs text-slate-500">
            {pr.branch} → {pr.baseBranch}
          </p>
          <p className="mt-1 text-xs text-slate-400">
            {author ?? 'Unknown'} requested review
            {reviewer ? ` from ${reviewer}` : ''}
          </p>
        </div>
        {pr.diff && (
          <button className="btn-ghost shrink-0 text-xs" onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide diff' : 'View diff'}
          </button>
        )}
      </div>
      {open && pr.diff && (
        <pre
          className="max-h-96 overflow-auto border-t border-surface-border bg-surface-2 px-4 py-3 font-mono text-xs text-slate-300"
          data-testid="pr-diff"
        >
          {pr.diff}
        </pre>
      )}
    </li>
  );
}
