import React from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Agent, AgentEvent, WorkItem, WorkItemStatus } from '@shared/index';
import { useApp, useBundle } from '../state';
import { Avatar, EmptyState, StatusPill, agentAvatar } from '../components/ui';

// Milestone-worthy activity for the dashboard — excludes noisy tool_call/
// tool_result/reasoning/status_change chatter (the full stream lives in Activity).
const IMPORTANT_EVENT_TYPES = new Set<AgentEvent['type']>([
  'message',
  'discussion',
  'escalation',
  'git',
  'pull_request',
  'subagent_completed',
  'subagent_failed',
]);

const STATUS_LABELS: Record<WorkItemStatus, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  in_progress: 'In Progress',
  review: 'In Review',
  done: 'Done',
};

const STATUS_BAR: Record<WorkItemStatus, string> = {
  backlog: 'bg-slate-500',
  todo: 'bg-sky-500',
  in_progress: 'bg-status-working',
  review: 'bg-amber-500',
  done: 'bg-status-done',
};

export function DashboardPage(): React.JSX.Element {
  const { projectId } = useParams<{ projectId: string }>();
  const { state } = useApp();
  const bundle = useBundle(projectId);
  const project = state.projects.find((p) => p.id === projectId);

  const epics = bundle.workItems.filter((w) => w.kind === 'epic');
  const tasks = bundle.workItems.filter((w) => w.kind === 'task');
  const activeTasks = tasks.filter((t) => t.status === 'in_progress' || t.status === 'todo');
  const doneTasks = tasks.filter((t) => t.status === 'done');
  const pendingQuestions = bundle.questions.filter((q) => q.status === 'pending');
  const openPulls = bundle.pulls.filter((p) => p.status !== 'merged');
  const working = bundle.agents.filter((a) => a.status === 'working');
  // "Online" = anyone not idle (working, needs input, or blocked).
  const activeAgents = bundle.agents.filter((a) => a.status !== 'idle');

  const byStatus = (list: WorkItem[]): Record<WorkItemStatus, number> => {
    const acc = { backlog: 0, todo: 0, in_progress: 0, review: 0, done: 0 } as Record<
      WorkItemStatus,
      number
    >;
    for (const w of list) acc[w.status] += 1;
    return acc;
  };
  const taskCounts = byStatus(tasks);
  const totalTasks = tasks.length;

  const recentEvents = bundle.events
    .filter((e) => IMPORTANT_EVENT_TYPES.has(e.type))
    .slice(-8)
    .reverse();

  return (
    <div className="h-full overflow-auto animate-fadeIn">
      <header className="border-b border-surface-border px-6 py-4">
        <h1 className="text-lg font-semibold text-slate-100">Dashboard</h1>
        <p className="text-sm text-slate-500">
          {project?.name ?? 'Project'} — overall status at a glance
        </p>
      </header>

      <div className="space-y-6 p-6">
        {/* KPI cards */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Kpi label="Epics" value={epics.length} to={`/p/${projectId}/board`} />
          <Kpi
            label="Active tasks"
            value={activeTasks.length}
            accent
            to={`/p/${projectId}/board`}
          />
          <Kpi label="Completed" value={doneTasks.length} to={`/p/${projectId}/board`} />
          <Kpi
            label="Needs input"
            value={pendingQuestions.length}
            warn={pendingQuestions.length > 0}
            to={`/p/${projectId}/board`}
          />
          <Kpi label="Open PRs" value={openPulls.length} to={`/p/${projectId}/git`} />
          <Kpi label="Working now" value={working.length} to={`/p/${projectId}/activity`} />
        </div>

        {/* Work distribution */}
        <section className="card p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-200">Task distribution</h2>
          {totalTasks === 0 ? (
            <p className="text-sm text-slate-500">
              No tasks yet. Ask the Team Lead in{' '}
              <Link className="text-accent-400" to={`/p/${projectId}/chat`}>
                Chat
              </Link>{' '}
              to start an epic.
            </p>
          ) : (
            <>
              <div className="mb-3 flex h-2.5 overflow-hidden rounded-full bg-surface-3">
                {(Object.keys(STATUS_LABELS) as WorkItemStatus[]).map((s) =>
                  taskCounts[s] > 0 ? (
                    <div
                      key={s}
                      className={STATUS_BAR[s]}
                      style={{ width: `${(taskCounts[s] / totalTasks) * 100}%` }}
                      title={`${STATUS_LABELS[s]}: ${taskCounts[s]}`}
                    />
                  ) : null,
                )}
              </div>
              <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-400">
                {(Object.keys(STATUS_LABELS) as WorkItemStatus[]).map((s) => (
                  <span key={s} className="flex items-center gap-1.5">
                    <span className={`h-2 w-2 rounded-full ${STATUS_BAR[s]}`} />
                    {STATUS_LABELS[s]} <span className="text-slate-500">{taskCounts[s]}</span>
                  </span>
                ))}
              </div>
            </>
          )}
        </section>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* Epics */}
          <section>
            <h2 className="mb-3 text-sm font-semibold text-slate-200">Epics</h2>
            {epics.length === 0 ? (
              <EmptyState title="No epics yet" hint="Each user request becomes an epic." />
            ) : (
              <div className="space-y-2">
                {epics.map((epic) => (
                  <EpicRow key={epic.id} epic={epic} tasks={tasks} projectId={projectId} />
                ))}
              </div>
            )}
          </section>

          {/* Active team members */}
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-200">
                Active now
                {activeAgents.length > 0 && (
                  <span className="ml-1.5 text-slate-500">{activeAgents.length}</span>
                )}
              </h2>
              <Link className="text-xs text-accent-400" to={`/p/${projectId}/agents`}>
                View team →
              </Link>
            </div>
            {activeAgents.length === 0 ? (
              <EmptyState
                title="All agents idle"
                hint="Teammates spin up here when the Team Lead assigns work."
              />
            ) : (
              <div className="space-y-2">
                {activeAgents.map((a) => (
                  <AgentRow key={a.id} agent={a} projectId={projectId} />
                ))}
              </div>
            )}
          </section>
        </div>

        {/* Recent activity */}
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-200">Highlights</h2>
            <Link className="text-xs text-accent-400" to={`/p/${projectId}/activity`}>
              View all activity →
            </Link>
          </div>
          {recentEvents.length === 0 ? (
            <EmptyState
              title="No highlights yet"
              hint="Key milestones — commits, PRs, escalations — show up here."
            />
          ) : (
            <ul className="card divide-y divide-surface-border p-0 text-sm">
              {recentEvents.map((e) => {
                const author = bundle.agents.find((a) => a.id === e.agentId);
                return (
                  <li key={e.id} className="flex items-center gap-3 px-4 py-2">
                    {author ? (
                      <Avatar
                        emoji={author.emoji}
                        color={author.color}
                        src={agentAvatar(author.catalogId, author.kind)}
                        size={22}
                      />
                    ) : (
                      <span className="h-[22px] w-[22px] rounded bg-surface-3" />
                    )}
                    <span className="w-28 shrink-0 truncate text-xs text-slate-500">
                      {author?.displayName ?? 'System'}
                    </span>
                    <span className="flex-1 truncate text-slate-300">{e.summary}</span>
                    <span className="shrink-0 text-xs text-slate-600">
                      {new Date(e.createdAt).toLocaleTimeString()}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  accent,
  warn,
  to,
}: {
  label: string;
  value: number;
  accent?: boolean;
  warn?: boolean;
  to: string;
}): React.JSX.Element {
  return (
    <Link to={to} className="card p-4 transition-shadow hover:shadow-pop" data-testid="kpi-card">
      <div
        className={`text-2xl font-semibold ${
          warn ? 'text-status-input' : accent ? 'text-accent-400' : 'text-slate-100'
        }`}
      >
        {value}
      </div>
      <div className="mt-0.5 text-xs text-slate-500">{label}</div>
    </Link>
  );
}

function EpicRow({
  epic,
  tasks,
  projectId,
}: {
  epic: WorkItem;
  tasks: WorkItem[];
  projectId?: string;
}): React.JSX.Element {
  const children = tasks.filter((t) => t.parentId === epic.id);
  const done = children.filter((t) => t.status === 'done').length;
  const pct = epic.progress || (children.length ? (done / children.length) * 100 : 0);
  return (
    <Link
      to={`/p/${projectId}/board`}
      className="card block p-3 transition-shadow hover:shadow-pop"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-sm font-medium text-slate-100">{epic.title}</p>
        <span className="shrink-0 text-xs text-slate-500">
          {Math.round(pct)}% · {done}/{children.length}
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3">
        <div
          className="h-full rounded-full bg-accent-500 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-1.5 text-xs text-slate-500">{STATUS_LABELS[epic.status]}</div>
    </Link>
  );
}

function AgentRow({ agent, projectId }: { agent: Agent; projectId?: string }): React.JSX.Element {
  return (
    <Link
      to={`/p/${projectId}/agents/${agent.id}`}
      className="card flex items-center gap-3 p-3 transition-shadow hover:shadow-pop"
    >
      <Avatar
        emoji={agent.emoji}
        color={agent.color}
        src={agentAvatar(agent.catalogId, agent.kind)}
        size={30}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-slate-100">
          {agent.displayName}
          {agent.kind === 'lead' && <span className="ml-1 text-xs text-slate-500">· Lead</span>}
        </p>
        <p className="truncate text-xs text-slate-500">{agent.description}</p>
      </div>
      <StatusPill status={agent.status} />
    </Link>
  );
}
