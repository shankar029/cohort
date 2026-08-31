/**
 * Deterministic verification-gate model.
 *
 * The orchestrator historically bolted build/constraint/QA gates onto ONE code
 * path inside `runWorkItemInner`; every other route to a terminal state (retry,
 * skip, re-dispatch, epic finish) could bypass them. A live run proved the cost:
 * a task reached `done` while still violating a hard constraint AND without ever
 * integrating into the epic clone.
 *
 * This module makes "may this work item advance?" a single, deterministic,
 * auditable decision. It is intentionally PURE: it does not touch the filesystem,
 * spawn processes, or call an LLM. The orchestrator runs the actual checks (using
 * the existing deterministic primitives - `producedRealChanges`,
 * `runProjectBuild`, `checkClone`, `runProjectTests`, the integration result) and
 * hands the raw outcomes here to be assembled into a `GateReport`. Same inputs =>
 * same report, so it is trivially unit-testable and the report is a faithful
 * audit record.
 */

/** pass = met; fail = genuinely unmet (consumes remediation budget);
 *  skip = not applicable (e.g. no test command); error = infra/timeout/install
 *  failure that must NOT be counted as a real failure (bounded retry, advisory). */
export type CheckStatus = 'pass' | 'fail' | 'skip' | 'error';

export type CheckSeverity = 'required' | 'advisory';

export type GateScope = 'task' | 'epic';

export interface CheckResult {
  id: string;
  severity: CheckSeverity;
  status: CheckStatus;
  /** Human-readable one-liner for logs/UI. */
  detail: string;
  /** Structured proof (command + output tail, violation list, files, ...). */
  evidence?: unknown;
}

export interface GateReport {
  workItemId: string;
  agentId: string;
  stream: string | null;
  scope: GateScope;
  ts: number;
  checks: CheckResult[];
  /** True when no REQUIRED check is in `fail`. `error`/`skip`/advisory never block. */
  passed: boolean;
  outcome: 'passed' | 'failed' | 'skipped';
}

export interface ReportMeta {
  workItemId: string;
  agentId: string;
  stream: string | null;
  scope: GateScope;
  ts?: number;
}

/**
 * The REQUIRED check ids for a stream at a given scope. Verifier roles are
 * matched by name; everything else is treated as a builder. v1 keeps strictly to
 * the four already-deterministic primitives - no coverage%, no narration-derived
 * checks - so the gate can never be non-deterministic.
 */
export function requiredChecks(stream: string | null, scope: GateScope): string[] {
  if (scope === 'epic') {
    return [
      'integrated-build',
      'integrated-constraints',
      'integrated-tests',
      'acceptance',
      'acceptance-probe',
    ];
  }
  const s = (stream ?? '').toLowerCase();
  if (s === 'reviewer') return ['review-comments'];
  if (s === 'security') return ['constraints'];
  if (s === 'qa') return ['tests', 'integrated'];
  // Builders (backend/frontend/data/devops/docs/default).
  return ['produced', 'build', 'constraints', 'integrated'];
}

/** A required check is failing only when its status is genuinely `fail`. */
export function reportPassed(checks: CheckResult[]): boolean {
  return !checks.some((c) => c.severity === 'required' && c.status === 'fail');
}

/** Assemble a report from already-computed check results (pure). */
export function makeReport(meta: ReportMeta, checks: CheckResult[]): GateReport {
  const passed = reportPassed(checks);
  return {
    workItemId: meta.workItemId,
    agentId: meta.agentId,
    stream: meta.stream,
    scope: meta.scope,
    ts: meta.ts ?? Date.now(),
    checks,
    passed,
    outcome: passed ? 'passed' : 'failed',
  };
}

/**
 * An explicit, recorded override (user chose "Skip"/"Merge anyway"). It is never
 * `passed` and never silent - it is the single audited exception the design
 * allows in place of a real pass.
 */
export function overrideReport(meta: ReportMeta, reason: string): GateReport {
  return {
    workItemId: meta.workItemId,
    agentId: meta.agentId,
    stream: meta.stream,
    scope: meta.scope,
    ts: meta.ts ?? Date.now(),
    checks: [{ id: 'override', severity: 'advisory', status: 'skip', detail: reason }],
    passed: false,
    outcome: 'skipped',
  };
}

/** The required checks that are genuinely failing (for evidence injection). */
export function failedRequired(report: GateReport): CheckResult[] {
  return report.checks.filter((c) => c.severity === 'required' && c.status === 'fail');
}

/** True when any check hit an infra `error` (caller may do one bounded retry). */
export function hasInfraError(report: GateReport): boolean {
  return report.checks.some((c) => c.status === 'error');
}

/** One-line human summary for logs/escalations. */
export function summarizeReport(report: GateReport): string {
  const parts = report.checks
    .filter((c) => c.status !== 'pass')
    .map((c) => `${c.id}:${c.status}${c.severity === 'required' ? '' : '(adv)'}`);
  const head = report.passed ? 'PASS' : report.outcome === 'skipped' ? 'OVERRIDE' : 'FAIL';
  return parts.length ? `${head} [${parts.join(', ')}]` : head;
}

/**
 * Helper for the orchestrator: given a stream+scope and a map of raw check
 * outcomes it computed, build the full CheckResult[] with correct severities,
 * filling any missing required check as `skip` (not applicable / not run).
 */
export function assembleChecks(
  stream: string | null,
  scope: GateScope,
  raw: Array<{ id: string; status: CheckStatus; detail: string; evidence?: unknown }>,
): CheckResult[] {
  const required = new Set(requiredChecks(stream, scope));
  const seen = new Set(raw.map((r) => r.id));
  const checks: CheckResult[] = raw.map((r) => ({
    id: r.id,
    severity: required.has(r.id) ? 'required' : 'advisory',
    status: r.status,
    detail: r.detail,
    evidence: r.evidence,
  }));
  // A required check the caller never ran is recorded as `skip` for transparency.
  for (const id of required) {
    if (!seen.has(id)) {
      checks.push({ id, severity: 'required', status: 'skip', detail: 'not run' });
    }
  }
  return checks;
}
