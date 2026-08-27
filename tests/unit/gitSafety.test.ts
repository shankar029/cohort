import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitService } from '../../src/server/git.js';
import { loadConfig } from '../../src/server/config.js';

/**
 * Regression tests for the 2026-08-21 incident where the app committed into its
 * own repo. Two invariants must hold forever:
 *  1) worktreeRoot is always an absolute path (never a relative in-repo path),
 *     even under `ATEAM_DB=:memory:` or a relative DB path.
 *  2) GitService.commitWork refuses to touch anything outside worktreeRoot, so a
 *     stray cwd inside a real repo can never trigger `git add -A` + commit there.
 */

const cleanups: string[] = [];
afterEach(() => {
  for (const d of cleanups.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(d);
  return d;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@local',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@local',
    },
  }).trim();
}

describe('git safety (incident regression)', () => {
  it('config.worktreeRoot is always absolute, even with :memory: or relative DB', () => {
    for (const dbVal of [':memory:', './data/x.sqlite', undefined]) {
      const cfg = loadConfig({ ATEAM_DB: dbVal } as NodeJS.ProcessEnv);
      expect(path.isAbsolute(cfg.worktreeRoot), `abs for ATEAM_DB=${dbVal}`).toBe(true);
      // Must not resolve to a bare in-cwd "worktrees" directory.
      expect(cfg.worktreeRoot).not.toBe(path.join(process.cwd(), 'worktrees'));
    }
  });

  it('an explicit relative ATEAM_WORKTREE_ROOT is resolved to an absolute path', () => {
    const cfg = loadConfig({ ATEAM_WORKTREE_ROOT: 'worktrees' } as NodeJS.ProcessEnv);
    expect(path.isAbsolute(cfg.worktreeRoot)).toBe(true);
  });

  it('commitWork refuses a path outside worktreeRoot and leaves that repo untouched', async () => {
    // A real repo that is NOT under worktreeRoot (stands in for the app/project repo).
    const outsideRepo = tmp('ateam-outside-');
    git(['init'], outsideRepo);
    fs.writeFileSync(path.join(outsideRepo, 'seed.txt'), 'seed\n');
    git(['add', '-A'], outsideRepo);
    git(['commit', '-m', 'seed'], outsideRepo);
    const before = git(['rev-parse', 'HEAD'], outsideRepo);

    // Dirty the repo so a rogue `git add -A` + commit *would* create a new commit.
    fs.writeFileSync(path.join(outsideRepo, 'rogue.txt'), 'should never be committed\n');

    const worktreeRoot = tmp('ateam-wtroot-');
    const gitSvc = new GitService(worktreeRoot);

    const res = await gitSvc.commitWork(outsideRepo, 'ateam: rogue commit attempt');

    expect(res.committed).toBe(false);
    expect(res.hash).toBeNull();
    // HEAD unchanged and the rogue file is still untracked (no commit happened).
    expect(git(['rev-parse', 'HEAD'], outsideRepo)).toBe(before);
    expect(git(['status', '--porcelain'], outsideRepo)).toContain('rogue.txt');
  });

  it('commitWork commits normally for a managed worktree under worktreeRoot', async () => {
    const worktreeRoot = tmp('ateam-wtroot2-');
    const managed = path.join(worktreeRoot, 'proj', 'epic');
    fs.mkdirSync(managed, { recursive: true });
    git(['init'], managed);
    fs.writeFileSync(path.join(managed, 'base.txt'), 'base\n');
    git(['add', '-A'], managed);
    git(['commit', '-m', 'base'], managed);

    fs.writeFileSync(path.join(managed, 'work.txt'), 'real work\n');
    const gitSvc = new GitService(worktreeRoot);
    const res = await gitSvc.commitWork(managed, 'ateam: real work');

    expect(res.committed).toBe(true);
    expect(res.hash).toMatch(/^[0-9a-f]{7,}$/);
  });
});

describe('per-task worktrees + integration (slice 5a)', () => {
  async function setupEpicClone(): Promise<{
    svc: GitService;
    epic: { branch: string; path: string };
    projectId: string;
    epicId: string;
    repoDir: string;
  }> {
    const repoDir = tmp('ateam-repo-');
    git(['init'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# base\n');
    git(['add', '-A'], repoDir);
    git(['commit', '-m', 'base'], repoDir);

    const worktreeRoot = tmp('ateam-wt5a-');
    const svc = new GitService(worktreeRoot);
    const projectId = 'prj';
    const epicId = 'epicA';
    const epic = await svc.createEpicWorktree(repoDir, projectId, epicId);
    return { svc, epic, projectId, epicId, repoDir };
  }

  it('forks a task clone off the epic branch and integrates it back', async () => {
    const { svc, epic, projectId, epicId } = await setupEpicClone();
    const task = await svc.createTaskWorktree(epic.path, projectId, epicId, 'task1');
    expect(task.branch).toBe('ateam/task-task1');
    expect(fs.existsSync(path.join(task.path, '.git'))).toBe(true);
    // The task clone is a SIBLING dir, never nested inside the epic clone.
    expect(task.path.startsWith(epic.path + path.sep)).toBe(false);

    fs.writeFileSync(path.join(task.path, 'feature.txt'), 'hello\n');
    const c = await svc.commitWork(task.path, 'task(frontend): add feature');
    expect(c.committed).toBe(true);

    const r = await svc.integrateTaskBranch(epic.path, epic.branch, task.path, task.branch);
    expect(r.ok).toBe(true);
    // The feature file + the task commit are now on the epic branch.
    expect(fs.existsSync(path.join(epic.path, 'feature.txt'))).toBe(true);
    const log = git(['log', epic.branch, '--oneline'], epic.path);
    expect(log).toMatch(/task\(frontend\): add feature/);
    expect(log).toMatch(/integrate ateam\/task-task1/);
  });

  it('reports a conflict (and leaves the epic branch clean) when two tasks edit the same file', async () => {
    const { svc, epic, projectId, epicId } = await setupEpicClone();
    // Task A edits README on its branch, integrates cleanly.
    const a = await svc.createTaskWorktree(epic.path, projectId, epicId, 'taskA');
    fs.writeFileSync(path.join(a.path, 'README.md'), '# from A\n');
    await svc.commitWork(a.path, 'task(a): edit readme');
    expect((await svc.integrateTaskBranch(epic.path, epic.branch, a.path, a.branch)).ok).toBe(true);

    // Task B forked from the ORIGINAL base (before A integrated) and edits the
    // same file differently -> conflict on integration.
    const b = await svc.createTaskWorktree(epic.path, projectId, epicId, 'taskB');
    // b was cloned AFTER A integrated, so re-create the divergence manually:
    git(['checkout', '-b', 'ateam/task-taskB2', `${epic.branch}~1`], b.path);
    fs.writeFileSync(path.join(b.path, 'README.md'), '# from B\n');
    await svc.commitWork(b.path, 'task(b): edit readme');
    const headBefore = git(['rev-parse', epic.branch], epic.path);
    const r = await svc.integrateTaskBranch(epic.path, epic.branch, b.path, 'ateam/task-taskB2');
    expect(r.ok).toBe(false);
    expect(r.conflict).toBe(true);
    // Epic branch is untouched (merge aborted), not left half-applied.
    expect(git(['rev-parse', epic.branch], epic.path)).toBe(headBefore);
    expect(git(['status', '--porcelain'], epic.path)).toBe('');
  });
});
