import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Agent, AgentNote, AgentTask, AgentTaskStatus, SkillInfo } from '@shared/index';
import { api } from '../api';
import { useApp, useBundle } from '../state';
import { Avatar, EmptyState, ModelSelect, StatusPill, agentAvatar } from '../components/ui';
import { Markdown } from '../components/Markdown';

const TASK_STATUS_META: Record<AgentTaskStatus, { label: string; dot: string; order: number }> = {
  todo: { label: 'To do', dot: 'bg-status-idle', order: 0 },
  doing: { label: 'Doing', dot: 'bg-status-working animate-pulseDot', order: 1 },
  done: { label: 'Done', dot: 'bg-status-done', order: 2 },
};

/** One epic's slice of an agent's personal work: its work items (each with its
 * sub-task checklist) and scratchpad notes. */
interface WorkItemTasks {
  workItemId: string | null;
  title: string;
  tasks: AgentTask[];
}
interface EpicGroup {
  key: string;
  epicId: string | null;
  title: string;
  items: WorkItemTasks[];
  tasks: AgentTask[];
  notes: AgentNote[];
}

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

  // Group the agent's personal tasks + notes by the epic they belong to, so the
  // page reads per-epic instead of one flat board. workItemId points at a task
  // work item; its parentId is the epic. Items with no epic fall under 'General'.
  const wiById = new Map(bundle.workItems.map((w) => [w.id, w]));
  const epicIdOf = (workItemId: string | null): string | null => {
    if (!workItemId) return null;
    const wi = wiById.get(workItemId);
    if (!wi) return null;
    return wi.kind === 'epic' ? wi.id : wi.parentId;
  };
  const groupMap = new Map<string, EpicGroup>();
  const groupFor = (epicId: string | null): EpicGroup => {
    const key = epicId ?? '__none__';
    let g = groupMap.get(key);
    if (!g) {
      const epic = epicId ? wiById.get(epicId) : undefined;
      g = { key, epicId, title: epic?.title ?? 'General', items: [], tasks: [], notes: [] };
      groupMap.set(key, g);
    }
    return g;
  };
  for (const t of tasks) groupFor(epicIdOf(t.workItemId)).tasks.push(t);
  for (const n of notes) groupFor(epicIdOf(n.workItemId)).notes.push(n);
  // Within each epic, nest tasks under their work item so the page reads
  // epic → work item → sub-task checklist.
  for (const g of groupMap.values()) {
    const byItem = new Map<string, WorkItemTasks>();
    for (const t of g.tasks) {
      const wiId = t.workItemId ?? '__loose__';
      let it = byItem.get(wiId);
      if (!it) {
        const wi = t.workItemId ? wiById.get(t.workItemId) : undefined;
        it = { workItemId: t.workItemId, title: wi?.title ?? 'Tasks', tasks: [] };
        byItem.set(wiId, it);
      }
      it.tasks.push(t);
    }
    g.items = [...byItem.values()].sort((a, b) => a.title.localeCompare(b.title));
  }
  const groups = [...groupMap.values()].sort((a, b) => {
    // Named epics first (by title), 'General' bucket last.
    if ((a.epicId === null) !== (b.epicId === null)) return a.epicId === null ? 1 : -1;
    return a.title.localeCompare(b.title);
  });

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
          <Avatar
            emoji={agent.emoji}
            color={agent.color}
            src={agentAvatar(agent.catalogId, agent.kind)}
            size={44}
          />
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

      <div className="space-y-6 p-6">
        {/* Living plan — agent-wide, the persona's current working memory. */}
        <section data-testid="scratchpad">
          <h2 className="mb-3 text-sm font-semibold text-slate-200">Living plan</h2>
          <div className="card p-4">
            {plan ? (
              <div data-testid="agent-plan" className="text-sm">
                <Markdown content={plan} />
              </div>
            ) : (
              <p className="text-xs text-slate-500">
                No plan yet — the agent maintains this as it works.
              </p>
            )}
          </div>
        </section>

        {/* Work grouped by epic: each epic gets its own tasks + scratchpad notes. */}
        <section data-testid="task-board">
          <h2 className="mb-3 text-sm font-semibold text-slate-200">Work by epic</h2>
          {groups.length === 0 ? (
            <EmptyState
              title="No work yet"
              hint="Tasks and notes appear here, grouped by epic, as this agent works."
            />
          ) : (
            <div className="space-y-4">
              {groups.map((g) => (
                <EpicGroupCard key={g.key} group={g} isEpic={g.epicId !== null} />
              ))}
            </div>
          )}
        </section>

        {/* Configuration */}
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

function EpicGroupCard({
  group,
  isEpic,
}: {
  group: EpicGroup;
  isEpic: boolean;
}): React.JSX.Element {
  const doneCount = group.tasks.filter((t) => t.status === 'done').length;
  return (
    <div className="card overflow-hidden p-0" data-testid="epic-group">
      <header className="flex items-center gap-2 border-b border-surface-border px-4 py-2.5">
        {isEpic ? (
          <span className="rounded bg-accent-500/15 px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-accent-400">
            Epic
          </span>
        ) : (
          <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-slate-400">
            Unassigned
          </span>
        )}
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-100">
          {group.title}
        </h3>
        {group.tasks.length > 0 && (
          <span className="shrink-0 text-xs text-slate-500">
            {doneCount}/{group.tasks.length} done
          </span>
        )}
      </header>
      <div className="grid gap-4 p-4 md:grid-cols-2">
        <div>
          <h4 className="label mb-2">Work items &amp; sub-tasks</h4>
          {group.items.length === 0 ? (
            <p className="text-xs text-slate-500">No tasks.</p>
          ) : (
            <div className="space-y-3">
              {group.items.map((it) => (
                <WorkItemTaskList key={it.workItemId ?? '__loose__'} item={it} />
              ))}
            </div>
          )}
        </div>
        <div>
          <h4 className="label mb-2">Scratchpad notes</h4>
          {group.notes.length === 0 ? (
            <p className="text-xs text-slate-500">No notes.</p>
          ) : (
            <ul className="space-y-1.5" data-testid="agent-notes">
              {group.notes.map((n) => (
                <li
                  key={n.id}
                  className="rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs text-slate-300"
                >
                  <span className="mr-2 text-slate-500">
                    {new Date(n.createdAt).toLocaleTimeString()}
                  </span>
                  {n.content}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/** One work item and the agent's sub-task checklist beneath it. */
function WorkItemTaskList({ item }: { item: WorkItemTasks }): React.JSX.Element {
  const done = item.tasks.filter((t) => t.status === 'done').length;
  const orderedTasks = [...item.tasks].sort(
    (a, b) => TASK_STATUS_META[a.status].order - TASK_STATUS_META[b.status].order,
  );
  return (
    <div data-testid="workitem-group">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-300">
          {item.title}
        </span>
        <span className="shrink-0 text-[0.7rem] text-slate-500">
          {done}/{item.tasks.length}
        </span>
      </div>
      <ul className="space-y-1.5">
        {orderedTasks.map((t) => {
          const meta = TASK_STATUS_META[t.status];
          return (
            <li
              key={t.id}
              className="flex items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs"
              data-testid="task-card"
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${meta.dot}`}
                title={meta.label}
                aria-hidden="true"
              />
              <span
                className={
                  t.status === 'done'
                    ? 'min-w-0 flex-1 truncate text-slate-500 line-through'
                    : 'min-w-0 flex-1 truncate text-slate-200'
                }
              >
                {t.title}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
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
