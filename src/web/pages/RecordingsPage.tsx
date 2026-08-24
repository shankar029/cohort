import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Link } from 'react-router-dom';
import type { RecordedTurn, RecordedTurnSummary } from '@shared/index';
import { useApp, useBundle } from '../state';
import { api } from '../api';
import { Avatar, agentAvatar, Banner, EmptyState, Spinner } from '../components/ui';
import { Markdown } from '../components/Markdown';

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function RecordingsPage(): React.JSX.Element {
  const { projectId } = useParams<{ projectId: string }>();
  const { state } = useApp();
  const bundle = useBundle(projectId);
  const project = state.projects.find((p) => p.id === projectId);
  const settingsEnabled = project?.settings.recordSessions === true;

  const [recordings, setRecordings] = useState<RecordedTurnSummary[]>([]);
  const [enabled, setEnabled] = useState(settingsEnabled);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [agentFilter, setAgentFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  const avatarById = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const a of bundle.agents) map.set(a.id, agentAvatar(a.catalogId, a.kind));
    return map;
  }, [bundle.agents]);

  const load = useCallback(async (): Promise<void> => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.recordings(projectId);
      setRecordings(res.recordings);
      setEnabled(res.enabled);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load recordings');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const clear = async (): Promise<void> => {
    if (!projectId) return;
    if (!confirm('Delete all session recordings for this project? This cannot be undone.')) return;
    await api.clearRecordings(projectId);
    setSelected(null);
    void load();
  };

  const filtered = recordings.filter((r) => (agentFilter ? r.agentId === agentFilter : true));

  if (!projectId) return <div className="p-6 text-sm text-slate-500">Project not found.</div>;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start justify-between border-b border-surface-border px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Session recordings</h1>
          <p className="text-sm text-slate-500">
            Full transcripts of every agent turn — prompts, reasoning, tool calls and replies — so
            you and the Team Lead can review exactly what happened.
          </p>
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            enabled
              ? 'bg-status-done/15 text-status-done'
              : 'bg-surface-2 text-slate-400 ring-1 ring-surface-border'
          }`}
          data-testid="recording-state"
        >
          {enabled ? '● Recording on' : 'Recording off'}
        </span>
      </header>

      {!enabled && (
        <div className="px-6 pt-4">
          <Banner kind="info">
            Recording is off. Turn it on in{' '}
            <Link className="underline" to={`/p/${projectId}/settings`}>
              Settings
            </Link>{' '}
            to capture new agent sessions. Existing recordings below (if any) are still viewable.
          </Banner>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 px-6 py-3">
        <label className="text-xs text-slate-500" htmlFor="rec-agent">
          Agent
        </label>
        <select
          id="rec-agent"
          className="input !min-h-0 w-48 py-1 text-xs"
          data-testid="recordings-agent-filter"
          value={agentFilter}
          onChange={(e) => setAgentFilter(e.target.value)}
        >
          <option value="">All agents</option>
          {bundle.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.displayName}
            </option>
          ))}
        </select>
        <div className="flex-1" />
        <button className="btn-ghost !min-h-0 px-2 py-1 text-xs" onClick={() => void load()}>
          Refresh
        </button>
        <a
          className="btn-ghost !min-h-0 px-2 py-1 text-xs"
          href={api.recordingsExportUrl(projectId, 'md')}
        >
          Export .md
        </a>
        <a
          className="btn-ghost !min-h-0 px-2 py-1 text-xs"
          href={api.recordingsExportUrl(projectId, 'jsonl')}
        >
          Export .jsonl
        </a>
        <button
          className="btn-danger !min-h-0 px-2 py-1 text-xs"
          data-testid="recordings-clear"
          onClick={() => void clear()}
        >
          Clear
        </button>
      </div>

      <div className="flex-1 overflow-auto px-6 pb-6" data-testid="recordings-list">
        {error && <Banner kind="error">{error}</Banner>}
        {loading ? (
          <Spinner label="Loading recordings…" />
        ) : filtered.length === 0 ? (
          <EmptyState
            title="No recordings yet"
            hint={
              enabled
                ? 'Chat with the Team Lead or assign work — agent turns will appear here.'
                : 'Enable recording in Settings, then assign work to capture sessions.'
            }
          />
        ) : (
          <ol className="space-y-2">
            {filtered.map((r) => (
              <li key={r.id}>
                <button
                  className="card flex w-full items-start gap-3 p-3 text-left hover:ring-1 hover:ring-brand-500/40"
                  data-testid="recording-row"
                  onClick={() => setSelected(r.id)}
                >
                  <Avatar
                    emoji="🧭"
                    color="#8aa"
                    size={28}
                    src={r.agentId ? (avatarById.get(r.agentId) ?? undefined) : undefined}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-medium text-slate-200">{r.agentName}</span>
                      {r.workItemTitle && (
                        <span className="truncate text-xs text-slate-500">· {r.workItemTitle}</span>
                      )}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-xs text-slate-400">{r.promptPreview}</p>
                  </div>
                  <div className="shrink-0 text-right text-[11px] text-slate-500">
                    <div>{new Date(r.startedAt).toLocaleString()}</div>
                    <div>
                      {fmtDuration(r.durationMs)} · {r.toolCount} tool
                      {r.toolCount === 1 ? '' : 's'}
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>

      {selected && projectId && (
        <RecordingDetail
          projectId={projectId}
          turnId={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function RecordingDetail({
  projectId,
  turnId,
  onClose,
}: {
  projectId: string;
  turnId: string;
  onClose: () => void;
}): React.JSX.Element {
  const [turn, setTurn] = useState<RecordedTurn | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .recording(projectId, turnId)
      .then((res) => {
        if (alive) setTurn(res.recording);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : 'Failed to load recording');
      });
    return () => {
      alive = false;
    };
  }, [projectId, turnId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Recording detail"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card flex max-h-[85vh] w-full max-w-3xl flex-col p-0">
        <div className="flex items-center justify-between border-b border-surface-border px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-100">
            {turn
              ? `${turn.agentName}${turn.workItemTitle ? ` — ${turn.workItemTitle}` : ''}`
              : 'Recording'}
          </h2>
          <button
            className="btn-ghost !min-h-0 px-2 py-1"
            onClick={onClose}
            aria-label="Close dialog"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4" data-testid="recording-detail">
          {error && <Banner kind="error">{error}</Banner>}
          {!turn && !error && <Spinner label="Loading…" />}
          {turn && (
            <div className="space-y-4 text-sm">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-400">
                <div>
                  <dt className="inline text-slate-500">Started: </dt>
                  <dd className="inline">{new Date(turn.startedAt).toLocaleString()}</dd>
                </div>
                <div>
                  <dt className="inline text-slate-500">Duration: </dt>
                  <dd className="inline">{fmtDuration(turn.durationMs)}</dd>
                </div>
                <div>
                  <dt className="inline text-slate-500">Model: </dt>
                  <dd className="inline">{turn.model}</dd>
                </div>
                <div className="truncate">
                  <dt className="inline text-slate-500">Dir: </dt>
                  <dd className="inline font-mono">{turn.cwd}</dd>
                </div>
              </dl>

              <section>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Prompt
                </h3>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-3 font-mono text-xs text-slate-300">
                  {turn.prompt}
                </pre>
              </section>

              {turn.events.length > 0 && (
                <section>
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Steps ({turn.events.length})
                  </h3>
                  <ol className="space-y-1">
                    {turn.events.map((e, i) => (
                      <li key={i} className="flex items-start gap-2 font-mono text-xs">
                        <span aria-hidden="true">
                          {e.kind === 'reasoning' ? '🧠' : e.kind === 'tool_call' ? '🔧' : '✅'}
                        </span>
                        <span className="min-w-0 flex-1 text-slate-400">{e.label}</span>
                      </li>
                    ))}
                  </ol>
                </section>
              )}

              <section>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Response
                </h3>
                {turn.response ? (
                  <Markdown content={turn.response} />
                ) : (
                  <p className="text-xs italic text-slate-500">(no text — tool-only turn)</p>
                )}
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
