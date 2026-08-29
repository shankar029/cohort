import { describe, it, expect } from 'vitest';
import {
  requiredChecks,
  reportPassed,
  makeReport,
  overrideReport,
  failedRequired,
  hasInfraError,
  summarizeReport,
  assembleChecks,
  type CheckResult,
} from '../../src/server/verification.js';

describe('verification model', () => {
  describe('requiredChecks', () => {
    it('builders require produced/build/constraints/integrated', () => {
      expect(requiredChecks('backend', 'task')).toEqual([
        'produced',
        'build',
        'constraints',
        'integrated',
      ]);
      expect(requiredChecks('frontend', 'task')).toEqual([
        'produced',
        'build',
        'constraints',
        'integrated',
      ]);
      expect(requiredChecks(null, 'task')).toContain('build');
    });
    it('qa requires tests + integrated; reviewer review-comments; security constraints', () => {
      expect(requiredChecks('qa', 'task')).toEqual(['tests', 'integrated']);
      expect(requiredChecks('reviewer', 'task')).toEqual(['review-comments']);
      expect(requiredChecks('security', 'task')).toEqual(['constraints']);
    });
    it('epic scope requires the integrated authority checks', () => {
      expect(requiredChecks('backend', 'epic')).toEqual([
        'integrated-build',
        'integrated-constraints',
        'integrated-tests',
        'acceptance',
      ]);
    });
  });

  describe('reportPassed / makeReport', () => {
    const meta = {
      workItemId: 'wi_1',
      agentId: 'agt_1',
      stream: 'backend',
      scope: 'task' as const,
    };

    it('passes when no required check fails', () => {
      const checks: CheckResult[] = [
        { id: 'produced', severity: 'required', status: 'pass', detail: '' },
        { id: 'build', severity: 'required', status: 'pass', detail: '' },
        { id: 'constraints', severity: 'required', status: 'pass', detail: '' },
        { id: 'integrated', severity: 'required', status: 'pass', detail: '' },
      ];
      expect(reportPassed(checks)).toBe(true);
      expect(makeReport(meta, checks).outcome).toBe('passed');
    });

    it('fails when a required check is genuinely failing', () => {
      const checks: CheckResult[] = [
        { id: 'build', severity: 'required', status: 'pass', detail: '' },
        { id: 'constraints', severity: 'required', status: 'fail', detail: 'disk write' },
      ];
      const r = makeReport(meta, checks);
      expect(r.passed).toBe(false);
      expect(r.outcome).toBe('failed');
      expect(failedRequired(r).map((c) => c.id)).toEqual(['constraints']);
    });

    it('error and skip on a required check do NOT block (only genuine fail does)', () => {
      const checks: CheckResult[] = [
        { id: 'build', severity: 'required', status: 'error', detail: 'timeout' },
        { id: 'tests', severity: 'required', status: 'skip', detail: 'no test cmd' },
      ];
      const r = makeReport(meta, checks);
      expect(r.passed).toBe(true);
      expect(hasInfraError(r)).toBe(true);
    });

    it('advisory fail does not block', () => {
      const checks: CheckResult[] = [
        { id: 'build', severity: 'required', status: 'pass', detail: '' },
        { id: 'docs-present', severity: 'advisory', status: 'fail', detail: 'no README' },
      ];
      expect(makeReport(meta, checks).passed).toBe(true);
    });
  });

  describe('overrideReport', () => {
    it('is never passed and is outcome=skipped', () => {
      const r = overrideReport(
        { workItemId: 'wi_1', agentId: 'agt_1', stream: null, scope: 'task' },
        'user chose merge anyway',
      );
      expect(r.passed).toBe(false);
      expect(r.outcome).toBe('skipped');
      expect(r.checks[0]!.id).toBe('override');
    });
  });

  describe('assembleChecks', () => {
    it('assigns required severity per spec and fills unrun required checks as skip', () => {
      const checks = assembleChecks('backend', 'task', [
        { id: 'produced', status: 'pass', detail: 'ok' },
        { id: 'build', status: 'pass', detail: 'ok' },
        // constraints + integrated not provided -> filled as skip/required
      ]);
      const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
      expect(byId.produced!.severity).toBe('required');
      expect(byId.constraints!.status).toBe('skip');
      expect(byId.constraints!.severity).toBe('required');
      expect(byId.integrated!.status).toBe('skip');
    });

    it('marks off-spec checks as advisory', () => {
      const checks = assembleChecks('backend', 'task', [
        { id: 'produced', status: 'pass', detail: '' },
        { id: 'build', status: 'pass', detail: '' },
        { id: 'constraints', status: 'pass', detail: '' },
        { id: 'integrated', status: 'pass', detail: '' },
        { id: 'lint', status: 'fail', detail: 'style' },
      ]);
      expect(checks.find((c) => c.id === 'lint')!.severity).toBe('advisory');
      expect(reportPassed(checks)).toBe(true);
    });
  });

  describe('summarizeReport', () => {
    it('summarizes failures compactly', () => {
      const r = makeReport({ workItemId: 'w', agentId: 'a', stream: 'backend', scope: 'task' }, [
        { id: 'build', severity: 'required', status: 'pass', detail: '' },
        { id: 'constraints', severity: 'required', status: 'fail', detail: 'x' },
      ]);
      expect(summarizeReport(r)).toContain('constraints:fail');
      expect(summarizeReport(r).startsWith('FAIL')).toBe(true);
    });
  });
});
