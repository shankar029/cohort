import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { SkillInfo } from '@shared/index';
import { api, type CatalogAgentDTOShape } from '../api';
import { useApp, useBundle } from '../state';
import { Avatar, Banner, ModelSelect, StatusPill, UsageChip, agentAvatar } from '../components/ui';
import { usageForAgent } from '../usage';

export function AgentsPage(): React.JSX.Element {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { deleteAgent } = useApp();
  const bundle = useBundle(projectId);
  const [showAdd, setShowAdd] = useState(false);

  const lead = bundle.agents.find((a) => a.kind === 'lead');
  const specialists = bundle.agents.filter((a) => a.kind === 'specialist');

  const removeAgent = (a: (typeof specialists)[number]): void => {
    if (!projectId) return;
    if (!window.confirm(`Remove ${a.displayName} from the team?`)) return;
    void deleteAgent(projectId, a.id);
  };

  return (
    <div className="h-full overflow-auto">
      <header className="flex items-center justify-between border-b border-surface-border px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Agents</h1>
          <p className="text-sm text-slate-500">
            Your team for this project. The Team Lead orchestrates the specialists.
          </p>
        </div>
        <button className="btn-primary" data-testid="add-agent" onClick={() => setShowAdd(true)}>
          ＋ Add agent
        </button>
      </header>

      <div className="space-y-6 p-6">
        {lead && (
          <div>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Team Lead
            </h2>
            <AgentRow
              emoji={lead.emoji}
              color={lead.color}
              src={agentAvatar(lead.catalogId, lead.kind)}
              displayName={lead.displayName}
              description={lead.description}
              model={lead.model}
              status={lead.status}
              usage={usageForAgent(bundle.usage, lead.id)}
              onClick={() => navigate(`/p/${projectId}/agents/${lead.id}`)}
            />
          </div>
        )}

        <div>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Specialists ({specialists.length})
          </h2>
          {specialists.length === 0 ? (
            <p className="rounded-lg border border-dashed border-surface-border p-6 text-center text-sm text-slate-500">
              No specialists yet. Add agents from the catalog to build your team.
            </p>
          ) : (
            <div className="grid gap-3" data-testid="agent-list">
              {specialists.map((a) => (
                <AgentRow
                  key={a.id}
                  emoji={a.emoji}
                  color={a.color}
                  src={agentAvatar(a.catalogId, a.kind)}
                  displayName={a.displayName}
                  description={a.description}
                  model={a.model}
                  status={a.status}
                  usage={usageForAgent(bundle.usage, a.id)}
                  onClick={() => navigate(`/p/${projectId}/agents/${a.id}`)}
                  onRemove={() => removeAgent(a)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {showAdd && projectId && (
        <AddAgentDrawer projectId={projectId} onClose={() => setShowAdd(false)} />
      )}
    </div>
  );
}

function AgentRow({
  emoji,
  color,
  src,
  displayName,
  description,
  model,
  status,
  usage,
  onClick,
  onRemove,
}: {
  emoji: string;
  color: string;
  src?: string | null;
  displayName: string;
  description: string;
  model: string;
  status: import('@shared/index').AgentStatus;
  usage?: { tokens: number; timeMs: number };
  onClick: () => void;
  onRemove?: () => void;
}): React.JSX.Element {
  return (
    <div className="card flex w-full items-center gap-3 p-3 hover:border-blue-500/50">
      <button
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
        onClick={onClick}
        data-testid="agent-card"
      >
        <Avatar emoji={emoji} color={color} src={src} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-slate-100">{displayName}</span>
            <StatusPill status={status} />
          </div>
          <p className="truncate text-xs text-slate-500">{description}</p>
        </div>
      </button>
      <span className="rounded bg-surface-2 px-2 py-0.5 text-xs text-slate-400">{model}</span>
      {usage && <UsageChip tokens={usage.tokens} timeMs={usage.timeMs} />}
      {onRemove && (
        <button
          className="btn-ghost !min-h-0 px-2 py-1 text-slate-400 hover:text-red-400"
          data-testid="remove-agent"
          title={`Remove ${displayName}`}
          aria-label={`Remove ${displayName}`}
          onClick={onRemove}
        >
          ✕
        </button>
      )}
    </div>
  );
}

function AddAgentDrawer({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}): React.JSX.Element {
  const { createAgent } = useApp();
  const bundle = useBundle(projectId);
  const [catalog, setCatalog] = useState<CatalogAgentDTOShape[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [tab, setTab] = useState<'catalog' | 'custom'>('catalog');
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState(bundle.agents[0]?.model ?? 'auto');

  useEffect(() => {
    void api.catalog().then((r) => setCatalog(r.agents));
    void api
      .skills(projectId)
      .then((r) => setSkills(r.skills))
      .catch(() => setSkills([]));
  }, [projectId]);

  const add = async (input: Record<string, unknown>, opts?: { close?: boolean }): Promise<void> => {
    setError(null);
    try {
      await createAgent(projectId, input);
      if (opts?.close) onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add agent');
    }
  };

  // Catalog agents already on the team (by catalogId) can't be added twice.
  const present = new Set(bundle.agents.map((a) => a.catalogId).filter(Boolean) as string[]);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/60"
      role="dialog"
      aria-modal="true"
      aria-label="Add agent"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="flex h-full w-full max-w-xl flex-col bg-surface-1">
        <div className="flex items-center justify-between border-b border-surface-border p-4">
          <h2 className="text-lg font-semibold text-slate-100">Add agent</h2>
          <button className="btn-ghost !min-h-0 px-2 py-1" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="flex gap-2 border-b border-surface-border px-4 py-2">
          <button
            className={tab === 'catalog' ? 'btn-primary' : 'btn-ghost'}
            onClick={() => setTab('catalog')}
          >
            Catalog
          </button>
          <button
            className={tab === 'custom' ? 'btn-primary' : 'btn-ghost'}
            data-testid="tab-custom"
            onClick={() => setTab('custom')}
          >
            Custom
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4">
          {error && (
            <div className="mb-3">
              <Banner kind="error">{error}</Banner>
            </div>
          )}
          <div className="mb-4">
            <label className="label" htmlFor="add-model">
              Model (applies to the new agent)
            </label>
            <ModelSelect id="add-model" value={model} onChange={setModel} />
          </div>

          {tab === 'catalog' ? (
            <div className="grid gap-3" data-testid="catalog-grid">
              <p className="text-xs text-slate-500">
                Add as many as you need — this panel stays open. Agents already on the team are
                marked.
              </p>
              {catalog.map((c) => {
                const added = present.has(c.id);
                return (
                  <div key={c.id} className="card flex items-center gap-3 p-3">
                    <Avatar emoji={c.emoji} color={c.color} src={agentAvatar(c.id)} />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-slate-100">{c.displayName}</p>
                      <p className="text-xs text-slate-500">{c.description}</p>
                    </div>
                    {added ? (
                      <span
                        className="rounded bg-surface-2 px-3 py-1.5 text-xs font-medium text-emerald-400"
                        data-testid={`added-${c.id}`}
                      >
                        ✓ Added
                      </span>
                    ) : (
                      <button
                        className="btn-primary"
                        data-testid={`add-catalog-${c.id}`}
                        onClick={() => void add({ catalogId: c.id, model })}
                      >
                        Add
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <CustomAgentForm
              skills={skills}
              model={model}
              onSubmit={(input) => add(input, { close: true })}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function CustomAgentForm({
  skills,
  model,
  onSubmit,
}: {
  skills: SkillInfo[];
  model: string;
  onSubmit: (input: Record<string, unknown>) => Promise<void>;
}): React.JSX.Element {
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);

  const toggleSkill = (name: string): void =>
    setSelectedSkills((s) => (s.includes(name) ? s.filter((x) => x !== name) : [...s, name]));

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit({ displayName, description, prompt, skills: selectedSkills, model });
      }}
    >
      <div>
        <label className="label" htmlFor="ca-name">
          Display name
        </label>
        <input
          id="ca-name"
          className="input"
          data-testid="custom-name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
        />
      </div>
      <div>
        <label className="label" htmlFor="ca-desc">
          Description (helps the Team Lead pick this agent)
        </label>
        <input
          id="ca-desc"
          className="input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div>
        <label className="label" htmlFor="ca-prompt">
          System prompt
        </label>
        <textarea
          id="ca-prompt"
          className="input"
          rows={4}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </div>
      <div>
        <span className="label">Skills to preload ({skills.length} discovered)</span>
        {skills.length === 0 ? (
          <p className="text-xs text-slate-500">
            No skills found in your home directory or this project.
          </p>
        ) : (
          <div className="flex max-h-40 flex-wrap gap-2 overflow-auto">
            {skills.map((s) => (
              <button
                type="button"
                key={s.path}
                className={`rounded-full border px-2 py-1 text-xs ${
                  selectedSkills.includes(s.name)
                    ? 'border-blue-500 bg-blue-500/20 text-blue-200'
                    : 'border-surface-border text-slate-400'
                }`}
                title={`${s.description} (${s.source})`}
                onClick={() => toggleSkill(s.name)}
              >
                {s.name}
                <span className="ml-1 text-[10px] text-slate-500">{s.source}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <button type="submit" className="btn-primary w-full" data-testid="custom-submit">
        Create agent
      </button>
    </form>
  );
}
