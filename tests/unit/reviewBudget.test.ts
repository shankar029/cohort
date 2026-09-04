import { describe, it, expect } from 'vitest';
import { reviewBudgetDecision } from '../../src/server/reviewBudget.js';

describe('reviewBudgetDecision', () => {
  it('continues when there are no open comments', () => {
    const d = reviewBudgetDecision({ iter: 5, maxIter: 3, cumulativeFixes: 99, maxFixes: 12, openCount: 0 });
    expect(d.action).toBe('continue');
  });

  it('continues while within both budgets', () => {
    const d = reviewBudgetDecision({ iter: 1, maxIter: 3, cumulativeFixes: 2, maxFixes: 12, openCount: 3 });
    expect(d.action).toBe('continue');
  });

  it('escalates when the round cap is reached', () => {
    const d = reviewBudgetDecision({ iter: 3, maxIter: 3, cumulativeFixes: 1, maxFixes: 12, openCount: 2 });
    expect(d.action).toBe('escalate');
    expect(d.reason).toMatch(/round cap/);
  });

  it('escalates when acting on comments would exceed the cumulative fix budget', () => {
    // 10 already + 4 more = 14 > 12
    const d = reviewBudgetDecision({ iter: 1, maxIter: 3, cumulativeFixes: 10, maxFixes: 12, openCount: 4 });
    expect(d.action).toBe('escalate');
    expect(d.reason).toMatch(/cumulative/);
  });

  it('does not escalate when exactly at the cumulative budget', () => {
    // 8 + 4 = 12, not > 12
    const d = reviewBudgetDecision({ iter: 1, maxIter: 3, cumulativeFixes: 8, maxFixes: 12, openCount: 4 });
    expect(d.action).toBe('continue');
  });

  it('treats maxFixes<=0 as an unbounded cumulative budget (rounds still cap)', () => {
    const d = reviewBudgetDecision({ iter: 1, maxIter: 3, cumulativeFixes: 999, maxFixes: 0, openCount: 5 });
    expect(d.action).toBe('continue');
  });
});
