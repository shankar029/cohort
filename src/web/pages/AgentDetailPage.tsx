import React, { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { AgentNote, AgentTask, AgentTaskStatus } from '@shared/index';
import { useApp, useBundle } from '../state';
import { Avatar, EmptyState, StatusPill } from '../components/ui';

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
          <dl className="card space-y-3 p-4 text-sm">
            <Field label="Machine name" value={agent.name} mono />
            <Field label="Model" value={agent.model} />
            <Field label="Tools" value={agent.tools ? agent.tools.join(', ') : 'All tools'} />
            <Field label="Skills" value={agent.skills.length ? agent.skills.join(', ') : 'None'} />
            <div>
              <dt className="label">System prompt</dt>
              <dd className="whitespace-pre-wrap rounded bg-surface-2 p-2 text-xs text-slate-300">
                {agent.prompt}
              </dd>
            </div>
          </dl>
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
          <pre
            className="mb-4 whitespace-pre-wrap rounded bg-surface-2 p-2 text-xs text-slate-300"
            data-testid="agent-plan"
          >
            {plan}
          </pre>
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
