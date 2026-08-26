import type { UsageEntry, WorkItem } from '@shared/index';

/** Sum of two usage tallies. */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  timeMs: number;
  turns: number;
}

export const emptyTotals = (): UsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  tokens: 0,
  timeMs: 0,
  turns: 0,
});

const add = (acc: UsageTotals, e: UsageEntry): UsageTotals => {
  acc.inputTokens += e.inputTokens;
  acc.outputTokens += e.outputTokens;
  acc.tokens += e.inputTokens + e.outputTokens;
  acc.timeMs += e.timeMs;
  acc.turns += e.turns;
  return acc;
};

/** Total usage for a single work item. For an epic, folds in its child tasks. */
export function usageForWorkItem(
  usage: UsageEntry[],
  workItems: WorkItem[],
  workItemId: string,
): UsageTotals {
  const item = workItems.find((w) => w.id === workItemId);
  const ids = new Set<string>([workItemId]);
  if (item?.kind === 'epic') {
    for (const w of workItems) if (w.parentId === workItemId) ids.add(w.id);
  }
  return usage.filter((u) => u.workItemId && ids.has(u.workItemId)).reduce(add, emptyTotals());
}

/** Total usage attributed to a single agent across all work. */
export function usageForAgent(usage: UsageEntry[], agentId: string): UsageTotals {
  return usage.filter((u) => u.agentId === agentId).reduce(add, emptyTotals());
}

/** Project-wide usage total. */
export function usageTotals(usage: UsageEntry[]): UsageTotals {
  return usage.reduce(add, emptyTotals());
}

/** Compact token count, e.g. 950, 12.3k, 4.1M. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Human duration from ms, e.g. 4s, 3m 12s, 1h 5m. */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) {
    const rem = s % 60;
    return rem ? `${m}m ${rem}s` : `${m}m`;
  }
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM ? `${h}h ${remM}m` : `${h}h`;
}
