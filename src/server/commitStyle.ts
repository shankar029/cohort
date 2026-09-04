/**
 * Commit-message policy. Cohort generates ALL git commits (per-epic snapshots,
 * task work, sync/integrate/merge bookkeeping), so a repository that mandates a
 * particular convention (e.g. Conventional Commits) can only satisfy it if the
 * harness emits compliant messages. This module centralizes every commit-message
 * string so the style is configurable and the merge-commit grep stays in lockstep
 * with what `mergeEpic` actually writes.
 */
export type CommitStyle = 'ateam' | 'conventional';

export function normalizeCommitStyle(v: string | undefined): CommitStyle {
  return v === 'conventional' ? 'conventional' : 'ateam';
}

const CC_TYPES = ['feat', 'fix', 'docs', 'test', 'refactor', 'perf', 'build', 'ci', 'chore', 'style'];

/** Infer a Conventional-Commits `type` from an explicit title prefix, then keywords, then stream. */
export function inferConventionalType(stream: string | null | undefined, title: string): string {
  const explicit = /^([a-z]+)(\([^)]*\))?!?:/i.exec(title.trim());
  const explicitType = explicit?.[1]?.toLowerCase();
  if (explicitType && CC_TYPES.includes(explicitType)) return explicitType;
  const t = title.toLowerCase();
  if (/\b(bug|fix|fixes|fixed|error|regression|broken|incorrect|defect)\b/.test(t)) return 'fix';
  if (/\b(docs?|document\w*|readme|changelog)\b/.test(t)) return 'docs';
  if (/\b(test|tests|spec|specs|coverage)\b/.test(t)) return 'test';
  if (/\b(refactor|rename|cleanup|reorganize|restructure)\b/.test(t)) return 'refactor';
  if (/\b(ci|pipeline|workflow|release)\b/.test(t)) return 'build';
  const s = (stream ?? '').toLowerCase();
  if (s === 'qa') return 'test';
  if (s === 'docs') return 'docs';
  if (s === 'devops') return 'ci';
  return 'feat';
}

/** Strip a leading `type:` / `type(scope):` the title may already carry, to avoid doubling. */
function subjectOf(title: string): string {
  return title.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, '').trim() || title.trim();
}

function scopeOf(stream: string | null | undefined): string {
  const s = (stream ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  return s || 'task';
}

export interface CommitMessages {
  style: CommitStyle;
  snapshot(): string;
  sync(branch: string): string;
  integrate(branch: string): string;
  merge(branch: string): string;
  /** `git log --grep` pattern that matches exactly what `merge()` writes. */
  mergeGrep(branch: string): string;
  task(stream: string | null | undefined, title: string): string;
}

export function commitMessages(style: CommitStyle): CommitMessages {
  const cc = style === 'conventional';
  return {
    style,
    snapshot: () => (cc ? 'chore: initial snapshot' : 'ateam: initial snapshot'),
    sync: (b) => (cc ? `chore(sync): ${b}` : `ateam: sync ${b}`),
    integrate: (b) => (cc ? `chore(integrate): ${b}` : `ateam: integrate ${b}`),
    merge: (b) => (cc ? `chore(merge): ${b}` : `ateam: merge ${b}`),
    // git --grep defaults to POSIX basic regex where "(" and ")" are literal, so
    // the conventional form matches without escaping. Anchors keep it exact.
    mergeGrep: (b) => (cc ? `^chore(merge): ${b}$` : `^ateam: merge ${b}$`),
    task: (stream, title) =>
      cc
        ? `${inferConventionalType(stream, title)}(${scopeOf(stream)}): ${subjectOf(title)}`
        : `task(${stream ?? 'task'}): ${title}`,
  };
}
