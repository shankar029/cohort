import { describe, it, expect } from 'vitest';
import {
  commitMessages,
  normalizeCommitStyle,
  inferConventionalType,
} from '../../src/server/commitStyle.js';

describe('normalizeCommitStyle', () => {
  it('defaults to ateam and only accepts conventional', () => {
    expect(normalizeCommitStyle(undefined)).toBe('ateam');
    expect(normalizeCommitStyle('')).toBe('ateam');
    expect(normalizeCommitStyle('nonsense')).toBe('ateam');
    expect(normalizeCommitStyle('conventional')).toBe('conventional');
  });
});

describe('commitMessages (ateam style, default — unchanged behavior)', () => {
  const m = commitMessages('ateam');
  it('keeps the historical prefixes', () => {
    expect(m.snapshot()).toBe('ateam: initial snapshot');
    expect(m.sync('ateam/epic-x')).toBe('ateam: sync ateam/epic-x');
    expect(m.integrate('ateam/task-y')).toBe('ateam: integrate ateam/task-y');
    expect(m.merge('ateam/epic-x')).toBe('ateam: merge ateam/epic-x');
    expect(m.mergeGrep('ateam/epic-x')).toBe('^ateam: merge ateam/epic-x$');
    expect(m.task('backend', 'store events')).toBe('task(backend): store events');
    expect(m.task(null, 'store events')).toBe('task(task): store events');
  });
  it('merge() and mergeGrep() stay in lockstep', () => {
    const b = 'ateam/epic-abc';
    // git --grep is anchored to the exact merge message (POSIX BRE, parens literal).
    expect(m.mergeGrep(b)).toBe(`^${m.merge(b)}$`);
    expect(new RegExp(m.mergeGrep(b)).test(m.merge(b))).toBe(true);
  });
});

describe('commitMessages (conventional style)', () => {
  const m = commitMessages('conventional');
  it('emits Conventional-Commits bookkeeping', () => {
    expect(m.snapshot()).toBe('chore: initial snapshot');
    expect(m.sync('ateam/epic-x')).toBe('chore(sync): ateam/epic-x');
    expect(m.integrate('ateam/task-y')).toBe('chore(integrate): ateam/task-y');
    expect(m.merge('ateam/epic-x')).toBe('chore(merge): ateam/epic-x');
  });
  it('merge() and mergeGrep() stay in lockstep (git BRE anchors to the exact message)', () => {
    const b = 'ateam/epic-abc';
    expect(m.mergeGrep(b)).toBe(`^${m.merge(b)}$`);
  });
  it('maps task work to a typed, scoped subject', () => {
    expect(m.task('backend', 'add weekly-active metric')).toBe('feat(backend): add weekly-active metric');
    expect(m.task('backend', 'BUG: importer drops rows')).toBe('fix(backend): importer drops rows');
    expect(m.task('qa', 'verify dashboard totals')).toBe('test(qa): verify dashboard totals');
    expect(m.task('docs', 'document the pipeline')).toBe('docs(docs): document the pipeline');
    expect(m.task('devops', 'wire release script')).toBe('build(devops): wire release script');
  });
  it('respects an explicit type already present in the title (no doubling)', () => {
    expect(m.task('backend', 'fix: correct off-by-one')).toBe('fix(backend): correct off-by-one');
    expect(m.task('frontend', 'feat(ui): add chart')).toBe('feat(frontend): add chart');
  });
});

describe('inferConventionalType', () => {
  it('prefers explicit prefix, then keywords, then stream', () => {
    expect(inferConventionalType('backend', 'fix: x')).toBe('fix');
    expect(inferConventionalType('backend', 'rename the module')).toBe('refactor');
    expect(inferConventionalType('qa', 'add more assertions')).toBe('test');
    expect(inferConventionalType('data', 'add a brand new query')).toBe('feat');
  });
});
