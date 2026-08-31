import React from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Agent, WorkItem, WorkItemStatus } from '@shared/index';
import { useApp, useBundle } from '../state';
import { Avatar, EmptyState, StatusPill, agentAvatar } from '../components/ui';
import { formatDuration, formatTokens, usageTotals } from '../usage';

const STATUS_LABELS: Record<WorkItemStatus, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  in_progress: 'In Progress',
  review: 'In Review',
  done: 'Done',
};

const STATUS_BAR: Record<WorkItemStatus, string> = {
  backlog: 'bg-slate-500',
  todo: 'bg-violet-500',
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
  const totals = usageTotals(bundle.usage);

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

  // What each agent is doing right now (their in-progress item), and the full
  // set of in-progress work for the “In progress now” board below.
  const epicById = new Map(epics.map((e) => [e.id, e] as const));
  const currentItemFor = (agentId: string): WorkItem | null =>
    tasks.find((t) => t.assigneeAgentId === agentId && t.status === 'in_progress') ?? null;
  const inProgress = tasks
    .filter((t) => t.status === 'in_progress')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

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
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
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
          <Kpi
            label="Time spent"
            value={formatDuration(totals.timeMs)}
            to={`/p/${projectId}/activity`}
          />
          <Kpi
            label="Tokens used"
            value={formatTokens(totals.tokens)}
            to={`/p/${projectId}/activity`}
          />
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
                  <AgentRow
                    key={a.id}
                    agent={a}
                    current={currentItemFor(a.id)}
                    projectId={projectId}
                  />
                ))}
              </div>
            )}
          </section>
        </div>

        {/* In progress now */}
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-200">
              In progress now
              {inProgress.length > 0 && (
                <span className="ml-1.5 text-slate-500">{inProgress.length}</span>
              )}
            </h2>
            <Link className="text-xs text-accent-400" to={`/p/${projectId}/board`}>
              View board →
            </Link>
          </div>
          {inProgress.length === 0 ? (
            <EmptyState
              title="Nothing in progress"
              hint="Active work items picked up by agents show up here in real time."
            />
          ) : (
            <ul
              className="card divide-y divide-surface-border p-0 text-sm"
              data-testid="in-progress-list"
            >
              {inProgress.map((t) => {
                const author = bundle.agents.find((a) => a.id === t.assigneeAgentId);
                const epic = t.parentId ? epicById.get(t.parentId) : undefined;
                return (
                  <li key={t.id} className="flex items-center gap-3 px-4 py-2.5">
                    {author ? (
                      <Avatar
                        emoji={author.emoji}
                        color={author.color}
                        src={agentAvatar(author.catalogId, author.kind)}
                        size={26}
                      />
                    ) : (
                      <span className="h-[26px] w-[26px] rounded bg-surface-3" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-slate-200">{t.title}</p>
                      <p className="truncate text-xs text-slate-500">
                        {author?.displayName ?? 'Unassigned'}
                        {epic && <span className="text-slate-600"> · {epic.title}</span>}
                      </p>
                    </div>
                    {t.stream && (
                      <span className="shrink-0 rounded bg-surface-3 px-1.5 py-0.5 text-[0.7rem] text-slate-400">
                        {t.stream}
                      </span>
                    )}
                    <span className="shrink-0 text-xs text-status-working">Working…</span>
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
  value: number | string;
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

function AgentRow({
  agent,
  current,
  projectId,
}: {
  agent: Agent;
  current: WorkItem | null;
  projectId?: string;
}): React.JSX.Element {
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
        <p className="truncate text-xs text-slate-500">
          {current ? (
            <>
              <span className="text-status-working">▸ </span>
              {current.title}
            </>
          ) : (
            agent.description
          )}
        </p>
      </div>
      <StatusPill status={agent.status} />
    </Link>
  );
}
