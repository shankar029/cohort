import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitService } from '../../src/server/git.js';

/**
 * Regression for the "empty epic / produced nothing" defect: a capable agent
 * runs git ITSELF (create files -> git add -> git commit) on its task branch,
 * leaving a clean working tree. The old working-tree-only detection reported
 * "produced no file changes" and the work never integrated. Detection and
 * commitWork must be commit-aware.
 */

const cleanups: string[] = [];
afterEach(() => {
  for (const d of cleanups.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@local',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@local',
};
function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: ENV }).trim();
}

describe('commit-aware work detection (empty-epic regression)', () => {
  it('credits an agent that commits its own work on the task branch', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-cawt-'));
    cleanups.push(root);

    // Epic clone with an epic branch + init commit.
    const epicDir = path.join(root, 'epic');
    fs.mkdirSync(epicDir, { recursive: true });
    git(['init', '-q'], epicDir);
    git(['checkout', '-q', '-b', 'ateam/epic-X'], epicDir);
    fs.writeFileSync(path.join(epicDir, 'README.md'), '# seed\n');
    git(['add', '-A'], epicDir);
    git(['commit', '-q', '-m', 'init'], epicDir);

    // Task clone forked off the epic clone (sets origin + origin/HEAD -> epic).
    const taskDir = path.join(root, 'task');
    git(['clone', '--no-hardlinks', '-q', epicDir, taskDir], root);
    git(['checkout', '-q', '-b', 'ateam/task-Y'], taskDir);

    const svc = new GitService(root);

    // Baseline: clean clone, no work yet.
    expect(await svc.hasWorkToIntegrate(taskDir)).toBe(false);
    expect(await svc.commitsAheadOfBase(taskDir)).toBe(0);

    // The AGENT does its own git: create files, add, commit. Working tree is now
    // clean (everything committed) - exactly the case that used to be lost.
    fs.mkdirSync(path.join(taskDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'src', 'store.js'), 'export const store = new Map();\n');
    git(['add', '-A'], taskDir);
    git(['commit', '-q', '-m', 'feat: in-memory store'], taskDir);
    const headBefore = git(['rev-parse', 'HEAD'], taskDir);

    // Working tree is clean, but the branch is ahead of base with real work.
    expect(await svc.changedFiles(taskDir)).toEqual([]);
    expect(await svc.commitsAheadOfBase(taskDir)).toBe(1);
    expect(await svc.hasWorkToIntegrate(taskDir)).toBe(true);
    expect(await svc.committedFilesAheadOfBase(taskDir)).toContain('src/store.js');

    // commitWork credits the agent's existing commit (no new commit) so the task
    // integrates with a real hash instead of returning committed:false.
    const res = await svc.commitWork(taskDir, 'task(backend): store');
    expect(res.committed).toBe(true);
    expect(res.hash).toBe(headBefore);
    expect(git(['rev-parse', 'HEAD'], taskDir)).toBe(headBefore); // unchanged - no empty commit
  });

  it('still commits an uncommitted working tree the normal way', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-cawt-'));
    cleanups.push(root);
    const epicDir = path.join(root, 'epic');
    fs.mkdirSync(epicDir, { recursive: true });
    git(['init', '-q'], epicDir);
    git(['checkout', '-q', '-b', 'ateam/epic-X'], epicDir);
    fs.writeFileSync(path.join(epicDir, 'README.md'), '# seed\n');
    git(['add', '-A'], epicDir);
    git(['commit', '-q', '-m', 'init'], epicDir);
    const taskDir = path.join(root, 'task');
    git(['clone', '--no-hardlinks', '-q', epicDir, taskDir], root);
    git(['checkout', '-q', '-b', 'ateam/task-Y'], taskDir);
    const svc = new GitService(root);

    // Agent leaves uncommitted files (fake-adapter / edit-only behavior).
    fs.writeFileSync(path.join(taskDir, 'app.js'), 'console.log(1);\n');
    expect(await svc.hasWorkToIntegrate(taskDir)).toBe(true);
    const res = await svc.commitWork(taskDir, 'task(backend): app');
    expect(res.committed).toBe(true);
    expect(res.hash).toBeTruthy();
    expect(await svc.commitsAheadOfBase(taskDir)).toBe(1);
  });
});

/**
 * Regression for the truncated-acceptance-diff false-fail: the acceptance/review
 * judge was fed only the first ~6KB of a 100KB textual diff, whose alphabetically
 * first entry was the large `.ateam/acceptance.mjs` harness - so the judge never
 * saw `public/app.js`/`server.js` and falsely ruled whole subsystems "not
 * delivered". `branchFileStat` gives the judge the COMPLETE file list (cheap,
 * .ateam-excluded) so it can never go blind that way again.
 */
describe('branchFileStat (complete, .ateam-excluded delivery evidence)', () => {
  it('lists delivered product files and EXCLUDES .ateam scaffolding', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-bfs-'));
    cleanups.push(root);

    const epicDir = path.join(root, 'epic');
    fs.mkdirSync(epicDir, { recursive: true });
    git(['init', '-q'], epicDir);
    git(['checkout', '-q', '-b', 'ateam/epic-X'], epicDir);
    fs.writeFileSync(path.join(epicDir, 'README.md'), '# seed\n');
    git(['add', '-A'], epicDir);
    git(['commit', '-q', '-m', 'init'], epicDir);

    const taskDir = path.join(root, 'task');
    git(['clone', '--no-hardlinks', '-q', epicDir, taskDir], root);
    git(['checkout', '-q', '-b', 'ateam/task-Y'], taskDir);

    // Real product files PLUS large .ateam scaffolding, all committed - mirroring
    // the epic where the acceptance harness sorted first and ate the diff budget.
    fs.writeFileSync(path.join(taskDir, 'server.js'), 'console.log("app");\n');
    fs.mkdirSync(path.join(taskDir, 'public'), { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'public', 'app.js'), 'export const x = 1;\n');
    fs.mkdirSync(path.join(taskDir, '.ateam', 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(taskDir, '.ateam', 'tasks', 'wi_1.md'), '# task card\n');
    fs.writeFileSync(
      path.join(taskDir, '.ateam', 'acceptance.mjs'),
      '// '.padEnd(4000, 'x') + '\n',
    );
    git(['add', '-A'], taskDir);
    git(['commit', '-q', '-m', 'feat: app'], taskDir);

    const svc = new GitService(root);
    const stat = await svc.branchFileStat(taskDir, 'ateam/epic-X');

    // The judge would SEE the real deliverables...
    expect(stat).toContain('server.js');
    expect(stat).toContain('public/app.js');
    // ...and NOT the .ateam scaffolding that used to dominate the truncated diff.
    expect(stat).not.toContain('.ateam');
    expect(stat).not.toContain('acceptance.mjs');
  });
});

/**
 * Runtime-artifact hygiene: a FRESH project repo is seeded with a default
 * .gitignore so agents can't commit sqlite DBs / node_modules / logs that block
 * merges ("untracked working tree files would be overwritten") or dominate the
 * acceptance/review diff. An EXISTING repo (or a pre-placed .gitignore) is never
 * touched.
 */
describe('ensureRepo seeds a default .gitignore (greenfield only)', () => {
  it('commits a .gitignore covering sqlite/node_modules in a fresh repo', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-ign-'));
    cleanups.push(root);
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo, { recursive: true });

    const svc = new GitService(root);
    await svc.ensureRepo(repo);

    // Committed (tracked), not just present.
    const tracked = git(['ls-files'], repo).split('\n');
    expect(tracked).toContain('.gitignore');
    const body = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8');
    expect(body).toMatch(/\*\.sqlite/);
    expect(body).toMatch(/node_modules\//);

    // A runtime sqlite artifact is now ignored (won't get committed or block a merge).
    fs.writeFileSync(path.join(repo, 'ledger.sqlite'), 'BINARYDB');
    expect(git(['status', '--porcelain'], repo)).toBe('');
  });

  it('does NOT clobber a repo that already has commits/.gitignore', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-ign2-'));
    cleanups.push(root);
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    git(['init', '-q'], repo);
    fs.writeFileSync(path.join(repo, '.gitignore'), 'custom-only/\n');
    fs.writeFileSync(path.join(repo, 'README.md'), '# existing\n');
    git(['add', '-A'], repo);
    git(['commit', '-q', '-m', 'init'], repo);

    const svc = new GitService(root);
    await svc.ensureRepo(repo);

    // The user's .gitignore is left exactly as-is.
    expect(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8')).toBe('custom-only/\n');
  });
});
