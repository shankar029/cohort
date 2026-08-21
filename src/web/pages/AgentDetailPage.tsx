import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Agent, AgentNote, AgentTask, AgentTaskStatus, SkillInfo } from '@shared/index';
import { api } from '../api';
import { useApp, useBundle } from '../state';
import { Avatar, EmptyState, ModelSelect, StatusPill } from '../components/ui';
import { Markdown } from '../components/Markdown';

const TASK_COLUMNS: { status: AgentTaskStatus; label: string }[] = [
  { status: 'todo', label: 'To Do' },
  { status: 'doing', label: 'Doing' },
  { status: 'done', label: 'Done' },
];

export function AgentDetailPage(): React.JSX.Element {
  const { projectId, agentId } = useParams<{ projectId: string; agentId: string }>();
  const navigate = useNavigate();
  const { loadAgentTasks, loadAgentNotes, deleteAgent } = useApp();
  const bundle = useBundle(projectId);
  const agent = bundle.agents.find((a) => a.id === agentId);
  const tasks = (agentId && bundle.tasksByAgent[agentId]) || [];
  const notes = (agentId && bundle.notesByAgent[agentId]) || [];
  const plan = (agentId && bundle.plansByAgent[agentId]) || '';
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (projectId && agentId) {
      void loadAgentTasks(projectId, agentId);
      void loadAgentNotes(projectId, agentId);
    }
  }, [projectId, agentId, loadAgentTasks, loadAgentNotes]);

  if (!agent) {
    return (
      <div className="p-6">
        <EmptyState title="Agent not found" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <header className="border-b border-surface-border px-6 py-4">
        <button
          className="mb-3 text-xs text-slate-500 hover:text-slate-300"
          onClick={() => navigate(`/p/${projectId}/agents`)}
        >
          ← Back to agents
        </button>
        <div className="flex items-center gap-3">
          <Avatar emoji={agent.emoji} color={agent.color} size={44} />
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold text-slate-100">{agent.displayName}</h1>
              <StatusPill status={agent.status} />
            </div>
            <p className="text-sm text-slate-500">{agent.description}</p>
          </div>
          <button
            className="btn-ghost"
            data-testid="edit-agent"
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? 'Close editor' : 'Edit'}
          </button>
          <button
            className="btn-ghost"
            onClick={() => navigate(`/p/${projectId}/activity?agent=${agent.id}`)}
          >
            View log
          </button>
          {agent.kind === 'specialist' && (
            <button
              className="btn-danger"
              data-testid="delete-agent"
              onClick={() =>
                projectId &&
                void deleteAgent(projectId, agent.id).then(() => navigate(`/p/${projectId}/agents`))
              }
            >
              Remove
            </button>
          )}
        </div>
      </header>

      <div className="grid gap-6 p-6 lg:grid-cols-[2fr_1fr]">
        <section>
          <h2 className="mb-3 text-sm font-semibold text-slate-200">Task board</h2>
          {tasks.length === 0 ? (
            <EmptyState
              title="No tasks yet"
              hint="Tasks appear here as this agent works on assigned items."
            />
          ) : (
            <div className="grid grid-cols-3 gap-3" data-testid="task-board">
              {TASK_COLUMNS.map((col) => (
                <TaskColumn
                  key={col.status}
                  label={col.label}
                  tasks={tasks.filter((t) => t.status === col.status)}
                />
              ))}
            </div>
          )}
        </section>

        <Scratchpad plan={plan} notes={notes} />

        <section>
          <h2 className="mb-3 text-sm font-semibold text-slate-200">Configuration</h2>
          {editing && projectId ? (
            <AgentEditor agent={agent} projectId={projectId} onDone={() => setEditing(false)} />
          ) : (
            <dl className="card space-y-3 p-4 text-sm">
              <Field label="Machine name" value={agent.name} mono />
              <Field label="Model" value={agent.model} />
              <Field label="Tools" value={agent.tools ? agent.tools.join(', ') : 'All tools'} />
              <Field
                label="Skills"
                value={agent.skills.length ? agent.skills.join(', ') : 'None'}
              />
              <div>
                <dt className="label">System prompt</dt>
                <dd className="whitespace-pre-wrap rounded bg-surface-2 p-2 text-xs text-slate-300">
                  {agent.prompt}
                </dd>
              </div>
            </dl>
          )}
        </section>
      </div>
    </div>
  );
}

function TaskColumn({ label, tasks }: { label: string; tasks: AgentTask[] }): React.JSX.Element {
  return (
    <div className="rounded-lg bg-surface-1/60 p-2">
      <h3 className="px-1 py-1 text-xs font-semibold text-slate-400">
        {label} <span className="text-slate-600">{tasks.length}</span>
      </h3>
      <div className="space-y-2">
        {tasks.map((t) => (
          <div key={t.id} className="card p-2 text-xs text-slate-200" data-testid="task-card">
            {t.title}
          </div>
        ))}
      </div>
    </div>
  );
}

function Scratchpad({ plan, notes }: { plan: string; notes: AgentNote[] }): React.JSX.Element {
  return (
    <section data-testid="scratchpad">
      <h2 className="mb-3 text-sm font-semibold text-slate-200">Scratchpad</h2>
      <div className="card p-4">
        <h3 className="label mb-1">Living plan</h3>
        {plan ? (
          <div
            className="mb-4 rounded bg-surface-2 p-2 text-xs text-slate-300"
            data-testid="agent-plan"
          >
            <Markdown content={plan} />
          </div>
        ) : (
          <p className="mb-4 text-xs text-slate-500">
            No plan yet — the agent maintains this as it works.
          </p>
        )}
        <h3 className="label mb-1">Notes</h3>
        {notes.length === 0 ? (
          <p className="text-xs text-slate-500">No notes yet.</p>
        ) : (
          <ul className="space-y-2" data-testid="agent-notes">
            {notes.map((n) => (
              <li key={n.id} className="rounded bg-surface-2 p-2 text-xs text-slate-300">
                <span className="mr-2 text-slate-600">
                  {new Date(n.createdAt).toLocaleTimeString()}
                </span>
                {n.content}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function AgentEditor({
  agent,
  projectId,
  onDone,
}: {
  agent: Agent;
  projectId: string;
  onDone: () => void;
}): React.JSX.Element {
  const { updateAgent } = useApp();
  const [displayName, setDisplayName] = useState(agent.displayName);
  const [description, setDescription] = useState(agent.description);
  const [prompt, setPrompt] = useState(agent.prompt);
  const [model, setModel] = useState(agent.model);
  const [selectedSkills, setSelectedSkills] = useState<string[]>(agent.skills);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .skills(projectId)
      .then((r) => setSkills(r.skills))
      .catch(() => undefined);
  }, [projectId]);

  const toggleSkill = (name: string): void =>
    setSelectedSkills((s) => (s.includes(name) ? s.filter((x) => x !== name) : [...s, name]));

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await updateAgent(projectId, agent.id, {
        displayName,
        description,
        prompt,
        model,
        skills: selectedSkills,
      });
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="card space-y-3 p-4"
      data-testid="agent-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div>
        <label className="label" htmlFor="edit-name">
          Display name
        </label>
        <input
          id="edit-name"
          className="input"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
        />
      </div>
      <div>
        <label className="label" htmlFor="edit-desc">
          Description
        </label>
        <input
          id="edit-desc"
          className="input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div>
        <label className="label" htmlFor="edit-model">
          Model
        </label>
        <ModelSelect id="edit-model" value={model} onChange={setModel} />
      </div>
      <div>
        <label className="label" htmlFor="edit-prompt">
          System prompt
        </label>
        <textarea
          id="edit-prompt"
          className="input font-mono text-xs"
          rows={10}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </div>
      <div>
        <span className="label">Skills to preload ({skills.length} discovered)</span>
        {skills.length === 0 ? (
          <p className="text-xs text-slate-500">No skills discovered.</p>
        ) : (
          <div className="flex max-h-40 flex-wrap gap-2 overflow-auto">
            {skills.map((s) => (
              <button
                type="button"
                key={s.path}
                className={`rounded-full border px-2 py-1 text-xs ${
                  selectedSkills.includes(s.name)
                    ? 'border-accent-500 bg-accent-500/20 text-accent-200'
                    : 'border-surface-border text-slate-400'
                }`}
                title={`${s.description} (${s.source})`}
                onClick={() => toggleSkill(s.name)}
              >
                {s.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex gap-2">
        <button type="submit" className="btn-primary" disabled={saving} data-testid="save-agent">
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        <button type="button" className="btn-ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
      <p className="text-xs text-slate-500">
        Saving restarts this agent&apos;s session so the new persona, model, and skills take effect
        immediately.
      </p>
    </form>
  );
}

function Field({
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
