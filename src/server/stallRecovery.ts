/**
 * Stall auto-recovery planning (pure). The Team Lead manager loop can leave an
 * epic silently wedged when a run/park guard leaks: e.g. an agent turn hangs (the
 * agent goes idle but the in-flight run promise never resolves), so the work item
 * stays in the `running` set forever — which also saturates its epic's
 * concurrency slot and blocks sibling tasks. `watchForStall` previously only
 * POSTED a diagnosis; this planner decides which stale guards to clear so the
 * board can actually move again.
 *
 * This function is pure so it can be unit-tested exhaustively. The orchestrator
 * only calls it once it has already established a HARD stall (open work exists, no
 * specialist is `working`, the user isn't being awaited on a pending question, and
 * the board has not moved for `stallMs`). Given that precondition, any TASK guard
 * here is provably stale.
 */
export interface StallItemState {
  id: string;
  kind: 'epic' | 'task';
  status: string;
  assigneeAgentId: string | null;
}

export interface StallRecoveryInput {
  items: StallItemState[];
  /** agentId -> current status ('idle' | 'working' | 'needs_input' | 'blocked' | …). */
  agentStatusById: Record<string, string | undefined>;
  /** Work-item ids currently flagged as running. */
  running: string[];
  /** Work-item ids currently flagged as awaiting a decision. */
  awaitingInput: string[];
  /** Work-item id -> epoch ms it entered the running set. */
  runningSince: Record<string, number>;
  now: number;
  /** How long a `running` guard may persist with an idle agent before it's deemed leaked. */
  runWatchdogMs: number;
}

export interface StallRecoveryPlan {
  /** Stale `running` guards to clear (hung/crashed runs). */
  clearRunning: string[];
  /** Leaked `awaitingInput` parks to clear (no decision is actually pending). */
  clearAwaiting: string[];
  /** Agents whose session should be restarted to abandon a possibly-hung turn. */
  restartAgentIds: string[];
  /** Whether the caller should re-run assignment/drive after applying the plan. */
  redrive: boolean;
}

function isIdle(status: string | undefined): boolean {
  // Treat unknown/missing as idle: the agent is not actively working, so a guard
  // attributed to it cannot correspond to a live turn.
  return status === undefined || status === 'idle';
}

export function planStallRecovery(input: StallRecoveryInput): StallRecoveryPlan {
  const byId = new Map(input.items.map((i) => [i.id, i]));
  const runningSet = new Set(input.running);
  const clearRunning: string[] = [];
  const clearAwaiting: string[] = [];
  const restartAgents = new Set<string>();

  for (const id of input.running) {
    const item = byId.get(id);
    if (!item || item.kind !== 'task') continue; // never touch epic-level guards
    const agentStatus = item.assigneeAgentId ? input.agentStatusById[item.assigneeAgentId] : undefined;
    if (!isIdle(agentStatus)) continue; // a live turn — leave it alone
    const since = input.runningSince[id] ?? input.now;
    // Generous watchdog: a legit post-turn gate/integration phase can run with the
    // agent idle for a while, so only clear runs that vastly exceed that window.
    if (input.now - since < input.runWatchdogMs) continue;
    clearRunning.push(id);
    if (item.assigneeAgentId) restartAgents.add(item.assigneeAgentId);
  }

  for (const id of input.awaitingInput) {
    const item = byId.get(id);
    if (!item || item.kind !== 'task') continue;
    // Only actionable tasks: if it's parked but sitting in todo/in_progress with an
    // idle agent and no pending question (caller precondition), the park is leaked.
    if (item.status !== 'todo' && item.status !== 'in_progress') continue;
    const agentStatus = item.assigneeAgentId ? input.agentStatusById[item.assigneeAgentId] : undefined;
    if (!isIdle(agentStatus)) continue;
    if (runningSet.has(id)) continue; // handled by the running pass
    clearAwaiting.push(id);
  }

  return {
    clearRunning,
    clearAwaiting,
    restartAgentIds: [...restartAgents],
    redrive: clearRunning.length > 0 || clearAwaiting.length > 0,
  };
}
