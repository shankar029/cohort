/**
 * Review-round budgeting (pure). The Team Lead re-reviews an epic each time all its
 * tasks reach `review`/`done`; if the reviewer leaves open comments, each becomes a
 * fix task and the cycle repeats. Two failure modes make this spiral instead of
 * converge:
 *
 *   1. Round count climbs but a round rarely *completes* (a fix task stays
 *      in-flight), so the round cap never bites.
 *   2. A single round can spawn arbitrarily many fix tasks that a single owner
 *      reworks serially — the board freezes for a very long time (observed live:
 *      t3 ran 80+ min at `review:4,in_progress:3,todo:2` and never merged).
 *
 * This helper decides, deterministically, when to stop grinding and escalate to the
 * user (converge-or-escalate) — bounding BOTH rounds and cumulative fix volume.
 */
export interface ReviewBudgetInput {
  /** 1-based count of completed review rounds for this epic. */
  iter: number;
  /** Per-epic round cap (ATEAM_MAX_REVIEW_ITER). */
  maxIter: number;
  /** Total fix tasks created across ALL rounds so far for this epic. */
  cumulativeFixes: number;
  /** Cap on cumulative fix tasks before forcing a decision (ATEAM_MAX_REVIEW_FIXES). */
  maxFixes: number;
  /** Open review comments in the current round. */
  openCount: number;
}

export type ReviewBudgetAction = 'continue' | 'escalate';

export interface ReviewBudgetDecision {
  action: ReviewBudgetAction;
  reason: string;
}

/**
 * Decide whether to keep routing review fixes or park the epic and ask the user.
 * `escalate` fires when the round cap is hit OR the cumulative fix budget would be
 * exceeded by acting on the current open comments. Otherwise `continue`.
 */
export function reviewBudgetDecision(input: ReviewBudgetInput): ReviewBudgetDecision {
  const { iter, maxIter, cumulativeFixes, maxFixes, openCount } = input;
  if (openCount <= 0) return { action: 'continue', reason: 'no open comments' };
  if (iter >= maxIter) {
    return {
      action: 'escalate',
      reason: `review-round cap reached (${iter}/${maxIter})`,
    };
  }
  // Acting on the current comments would create `openCount` more fix tasks; if that
  // pushes the epic past its cumulative budget, force a decision instead.
  if (maxFixes > 0 && cumulativeFixes + openCount > maxFixes) {
    return {
      action: 'escalate',
      reason: `cumulative review-fix budget reached (${cumulativeFixes}+${openCount} > ${maxFixes})`,
    };
  }
  return { action: 'continue', reason: 'within budget' };
}
