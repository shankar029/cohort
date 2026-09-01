import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../state';
import { api } from '../api';
import {
  Banner,
  EmptyState,
  ModelSelect,
  Spinner,
  ThemeToggle,
  PaletteToggle,
} from '../components/ui';

export function ProjectsPage(): React.JSX.Element {
  const { state, createProject } = useApp();
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div className="h-full overflow-auto">
      <header className="border-b border-surface-border bg-surface-1 px-8 py-5">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <div>
            <h1 className="flex items-center gap-2.5 text-xl font-semibold text-slate-100">
              <span
                className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-lg"
                style={{ background: 'linear-gradient(145deg,#2b2b3f,#12121d)' }}
                aria-hidden="true"
              >
                <img src="/brand/mark.png" alt="" className="h-full w-full object-contain" />
              </span>
              Cohort
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              Orchestrate GitHub Copilot agents across your local repositories.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <PaletteToggle />
            <ThemeToggle />
            <button
              className="btn-primary"
              data-testid="new-project"
              onClick={() => setShowCreate(true)}
            >
              ＋ New Project
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-5xl p-8">
        {!state.projectsLoaded ? (
          <Spinner label="Loading projects…" />
        ) : state.projects.length === 0 ? (
          <EmptyState
            title="No projects yet"
            hint="Create a project pointing at a locally checked-out repository. Each project gets its own team of agents that work in that directory."
            action={
              <button className="btn-primary" onClick={() => setShowCreate(true)}>
                Create your first project
              </button>
            }
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="project-grid">
            {state.projects.map((p) => (
              <ProjectCard
                key={p.id}
                id={p.id}
                name={p.name}
                repoDir={p.repoDir}
                model={p.settings.defaultModel}
              />
            ))}
          </div>
        )}
      </div>

      {showCreate && (
        <CreateProjectModal onClose={() => setShowCreate(false)} onCreate={createProject} />
      )}
    </div>
  );
}

function ProjectCard({
  id,
  name,
  repoDir,
  model,
}: {
  id: string;
  name: string;
  repoDir: string;
  model: string;
}): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <button
      className="card p-4 text-left transition-colors hover:border-blue-500/60"
      onClick={() => navigate(`/p/${id}/chat`)}
      data-testid="project-card"
    >
      <h3 className="font-semibold text-slate-100">{name}</h3>
      <p className="mt-1 truncate text-xs text-slate-500" title={repoDir}>
        {repoDir}
      </p>
      <p className="mt-3 inline-block rounded bg-surface-2 px-2 py-0.5 text-xs text-slate-400">
        {model}
      </p>
    </button>
  );
}

function CreateProjectModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (input: { name: string; repoDir: string; defaultModel?: string }) => Promise<unknown>;
}): React.JSX.Element {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [repoDir, setRepoDir] = useState('');
  const [model, setModel] = useState('auto');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const project = (await onCreate({ name, repoDir, defaultModel: model })) as { id: string };
      navigate(`/p/${project.id}/agents`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project');
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Create project"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <form className="card w-full max-w-lg p-5" onSubmit={submit}>
        <h2 className="mb-4 text-lg font-semibold text-slate-100">New project</h2>
        <div className="space-y-3">
          <div>
            <label className="label" htmlFor="p-name">
              Project name
            </label>
            <input
              id="p-name"
              className="input"
              data-testid="project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Checkout Redesign"
              required
              autoFocus
            />
          </div>
          <div>
            <label className="label" htmlFor="p-repo">
              Repository directory
            </label>
            <div className="flex gap-2">
              <input
                id="p-repo"
                className="input font-mono text-xs"
                data-testid="project-repo"
                value={repoDir}
                onChange={(e) => setRepoDir(e.target.value)}
                placeholder="C:\\Code\\my-app"
                required
              />
              <button
                type="button"
                className="btn-ghost shrink-0"
                data-testid="project-browse"
                onClick={() => setBrowsing(true)}
              >
                Browse…
              </button>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Pick a locally checked-out repository, or paste an absolute path.
            </p>
          </div>
          <div>
            <label className="label" htmlFor="p-model">
              Default model
            </label>
            <ModelSelect id="p-model" value={model} onChange={setModel} />
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
            data-testid="project-submit"
            disabled={busy}
          >
            {busy ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </form>
      {browsing && (
        <FolderPicker
          initial={repoDir}
          onClose={() => setBrowsing(false)}
          onSelect={(p) => {
            setRepoDir(p);
            setBrowsing(false);
          }}
        />
      )}
    </div>
  );
}

function FolderPicker({
  initial,
  onClose,
  onSelect,
}: {
  initial?: string;
  onClose: () => void;
  onSelect: (path: string) => void;
}): React.JSX.Element {
  const [cur, setCur] = useState<string | null>(initial || null);
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<{ name: string; path: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = (p?: string): void => {
    setLoading(true);
    setError(null);
    api
      .listDirs(p)
      .then((r) => {
        setCur(r.path);
        setParent(r.parent);
        setEntries(r.entries);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Cannot open folder'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load(initial || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Choose folder"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="card flex h-[70vh] w-full max-w-lg flex-col p-4">
        <div className="mb-2 flex items-center gap-2">
          <button
            type="button"
            className="btn-ghost px-2"
            disabled={parent === null}
            onClick={() => parent && load(parent)}
            aria-label="Up one level"
            title="Up one level"
          >
            ↑
          </button>
          <div
            className="input flex-1 truncate font-mono text-xs"
            title={cur ?? ''}
            data-testid="folder-current"
          >
            {cur ?? 'This PC'}
          </div>
        </div>
        {error && <Banner kind="error">{error}</Banner>}
        <div className="min-h-0 flex-1 overflow-auto rounded-md border border-surface-border">
          {loading ? (
            <div className="p-4">
              <Spinner label="Loading…" />
            </div>
          ) : entries.length === 0 ? (
            <p className="p-4 text-center text-xs text-slate-500">No sub-folders here.</p>
          ) : (
            <ul className="divide-y divide-surface-border" data-testid="folder-list">
              {entries.map((e) => (
                <li key={e.path}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-200 hover:bg-surface-2"
                    onClick={() => load(e.path)}
                    data-testid="folder-entry"
                  >
                    <span aria-hidden="true">📁</span>
                    <span className="truncate">{e.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            data-testid="folder-select"
            disabled={!cur}
            onClick={() => cur && onSelect(cur)}
          >
            Select this folder
          </button>
        </div>
      </div>
    </div>
  );
}
