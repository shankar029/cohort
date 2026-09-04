import { describe, it, expect } from 'vitest';
import { planStallRecovery, type StallRecoveryInput } from '../../src/server/stallRecovery.js';

const WATCHDOG = 300000; // 5 min

function base(over: Partial<StallRecoveryInput> = {}): StallRecoveryInput {
  return {
    items: [],
    agentStatusById: {},
    running: [],
    awaitingInput: [],
    runningSince: {},
    now: 1_000_000,
    runWatchdogMs: WATCHDOG,
    ...over,
  };
}

describe('planStallRecovery', () => {
  it('clears a leaked running guard whose agent is idle and past the watchdog', () => {
    const plan = planStallRecovery(
      base({
        items: [{ id: 't1', kind: 'task', status: 'in_progress', assigneeAgentId: 'a1' }],
        agentStatusById: { a1: 'idle' },
        running: ['t1'],
        runningSince: { t1: 1_000_000 - WATCHDOG - 1 },
      }),
    );
    expect(plan.clearRunning).toEqual(['t1']);
    expect(plan.restartAgentIds).toEqual(['a1']);
    expect(plan.redrive).toBe(true);
  });

  it('does NOT clear a running guard whose agent is still working (live turn)', () => {
    const plan = planStallRecovery(
      base({
        items: [{ id: 't1', kind: 'task', status: 'in_progress', assigneeAgentId: 'a1' }],
        agentStatusById: { a1: 'working' },
        running: ['t1'],
        runningSince: { t1: 0 },
      }),
    );
    expect(plan.clearRunning).toEqual([]);
    expect(plan.redrive).toBe(false);
  });

  it('does NOT clear a running guard that is within the watchdog window (legit gate phase)', () => {
    const plan = planStallRecovery(
      base({
        items: [{ id: 't1', kind: 'task', status: 'in_progress', assigneeAgentId: 'a1' }],
        agentStatusById: { a1: 'idle' },
        running: ['t1'],
        runningSince: { t1: 1_000_000 - 60_000 }, // only 1 min
      }),
    );
    expect(plan.clearRunning).toEqual([]);
    expect(plan.redrive).toBe(false);
  });

  it('never touches epic-level guards', () => {
    const plan = planStallRecovery(
      base({
        items: [{ id: 'e1', kind: 'epic', status: 'review', assigneeAgentId: 'lead' }],
        agentStatusById: { lead: 'idle' },
        running: ['e1'],
        runningSince: { e1: 0 },
        awaitingInput: ['e1'],
      }),
    );
    expect(plan.clearRunning).toEqual([]);
    expect(plan.clearAwaiting).toEqual([]);
    expect(plan.redrive).toBe(false);
  });

  it('clears a leaked awaitingInput park on an actionable task with an idle agent', () => {
    const plan = planStallRecovery(
      base({
        items: [{ id: 't2', kind: 'task', status: 'todo', assigneeAgentId: 'a2' }],
        agentStatusById: { a2: 'idle' },
        awaitingInput: ['t2'],
      }),
    );
    expect(plan.clearAwaiting).toEqual(['t2']);
    expect(plan.redrive).toBe(true);
  });

  it('does not clear an awaiting park for a task in review/done', () => {
    const plan = planStallRecovery(
      base({
        items: [{ id: 't3', kind: 'task', status: 'review', assigneeAgentId: 'a3' }],
        agentStatusById: { a3: 'idle' },
        awaitingInput: ['t3'],
      }),
    );
    expect(plan.clearAwaiting).toEqual([]);
    expect(plan.redrive).toBe(false);
  });

  it('treats a missing/unknown agent as idle (guard cannot be a live turn)', () => {
    const plan = planStallRecovery(
      base({
        items: [{ id: 't4', kind: 'task', status: 'in_progress', assigneeAgentId: null }],
        running: ['t4'],
        runningSince: { t4: 0 },
      }),
    );
    expect(plan.clearRunning).toEqual(['t4']);
    expect(plan.restartAgentIds).toEqual([]); // no agent to restart
  });

  it('reproduces the t3 stall: assigned todo task + idle agents + a leaked sibling running guard', () => {
    // A sibling review-fix run hung (agent idle, guard leaked past watchdog) which
    // saturated the epic slot; the todo task is parked. Recovery frees both.
    const plan = planStallRecovery(
      base({
        items: [
          { id: 'hung', kind: 'task', status: 'in_progress', assigneeAgentId: 'data' },
          { id: 'todo', kind: 'task', status: 'todo', assigneeAgentId: 'data' },
        ],
        agentStatusById: { data: 'idle' },
        running: ['hung'],
        runningSince: { hung: 1_000_000 - WATCHDOG - 5000 },
        awaitingInput: ['todo'],
      }),
    );
    expect(plan.clearRunning).toEqual(['hung']);
    expect(plan.clearAwaiting).toEqual(['todo']);
    expect(plan.restartAgentIds).toEqual(['data']);
    expect(plan.redrive).toBe(true);
  });
});
