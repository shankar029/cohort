import React, { useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type { AgentEvent, AgentEventType } from '@shared/index';
import { useBundle } from '../state';
import { Avatar, EmptyState, StatusPill } from '../components/ui';

const TYPE_STYLE: Record<AgentEventType, { icon: string; color: string }> = {
  message: { icon: '💬', color: 'text-slate-300' },
  reasoning: { icon: '🧠', color: 'text-purple-300' },
  tool_call: { icon: '🔧', color: 'text-blue-300' },
  tool_result: { icon: '✅', color: 'text-emerald-300' },
  subagent_started: { icon: '▶️', color: 'text-blue-300' },
  subagent_completed: { icon: '🏁', color: 'text-emerald-300' },
  subagent_failed: { icon: '❌', color: 'text-red-300' },
  status_change: { icon: '🔄', color: 'text-slate-400' },
  escalation: { icon: '🙋', color: 'text-amber-300' },
  discussion: { icon: '🗣️', color: 'text-cyan-300' },
  git: { icon: '🔀', color: 'text-orange-300' },
  pull_request: { icon: '🔃', color: 'text-fuchsia-300' },
  system: { icon: 'ℹ️', color: 'text-slate-400' },
};

export function ActivityPage(): React.JSX.Element {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const bundle = useBundle(projectId);
  const filterAgent = searchParams.get('agent') ?? '';
  const [typeFilter, setTypeFilter] = useState<string>('');

  const nameById = useMemo(() => {
    const map = new Map<string, { name: string; emoji: string; color: string }>();
    for (const a of bundle.agents)
      map.set(a.id, { name: a.displayName, emoji: a.emoji, color: a.color });
    return map;
  }, [bundle.agents]);

  const events = bundle.events
    .filter((e) => (filterAgent ? e.agentId === filterAgent : true))
    .filter((e) => (typeFilter ? e.type === typeFilter : true));

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-surface-border px-6 py-4">
        <h1 className="text-lg font-semibold text-slate-100">Activity</h1>
        <p className="text-sm text-slate-500">
          Live status and logs across all agents. You only chat with the Lead — but you can watch
          everyone work here.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-3 border-b border-surface-border px-6 py-3">
        {bundle.agents.map((a) => (
          <div key={a.id} className="flex items-center gap-2 rounded-md bg-surface-2 px-2 py-1">
            <Avatar emoji={a.emoji} color={a.color} size={20} />
            <span className="text-xs text-slate-300">{a.displayName}</span>
            <StatusPill status={a.status} />
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3 px-6 py-3">
        <label className="text-xs text-slate-500" htmlFor="filter-agent">
          Agent
        </label>
        <select
          id="filter-agent"
          className="input !min-h-0 w-48 py-1 text-xs"
          data-testid="activity-agent-filter"
          value={filterAgent}
          onChange={(e) => setSearchParams(e.target.value ? { agent: e.target.value } : {})}
        >
          <option value="">All agents</option>
          {bundle.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.displayName}
            </option>
          ))}
        </select>
        <label className="text-xs text-slate-500" htmlFor="filter-type">
          Type
        </label>
        <select
          id="filter-type"
          className="input !min-h-0 w-40 py-1 text-xs"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
        >
          <option value="">All types</option>
          {Object.keys(TYPE_STYLE).map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      <div className="flex-1 overflow-auto px-6 pb-6" data-testid="activity-log">
        {events.length === 0 ? (
          <EmptyState
            title="No activity yet"
            hint="Assign work or chat with the Team Lead to see agents in action."
          />
        ) : (
          <ol className="space-y-1">
            {events
              .slice()
              .reverse()
              .map((e) => (
                <LogLine
                  key={e.id}
                  event={e}
                  who={e.agentId ? nameById.get(e.agentId) : undefined}
                />
              ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function LogLine({
  event,
  who,
}: {
  event: AgentEvent;
  who?: { name: string; emoji: string; color: string };
}): React.JSX.Element {
  const style = TYPE_STYLE[event.type];
  const time = new Date(event.createdAt).toLocaleTimeString();
  return (
    <li
      className="flex items-start gap-2 rounded px-2 py-1 font-mono text-xs hover:bg-surface-1"
      data-testid="log-line"
    >
      <span className="text-slate-600">{time}</span>
      <span aria-hidden="true">{style.icon}</span>
      <span className="shrink-0 text-slate-500">
        {who ? `${who.emoji} ${who.name}` : '🧭 Team Lead'}
      </span>
      <span className={`min-w-0 flex-1 ${style.color}`}>{event.summary}</span>
    </li>
  );
}
