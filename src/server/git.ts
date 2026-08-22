import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Thin wrapper over the git CLI. Isolates each epic in its own branch + worktree
 * so agents working on different epics never share a filesystem (no stepping on
 * each other). All operations are scoped to the project's repo; `main` is never
 * touched until an explicit merge, and nothing is pushed to a remote.
 */
export class GitService {
  private readonly worktreeRoot: string;
  constructor(worktreeRoot: string) {
    // Always absolute so worktree paths can never resolve inside a project/app repo.
    this.worktreeRoot = path.resolve(worktreeRoot);
  }

  private run(
    args: string[],
    cwd: string,
  ): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile(
        'git',
        args,
        {
          cwd,
          windowsHide: true,
          maxBuffer: 10 * 1024 * 1024,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'ateam',
            GIT_AUTHOR_EMAIL: 'ateam@local',
            GIT_COMMITTER_NAME: 'ateam',
            GIT_COMMITTER_EMAIL: 'ateam@local',
          },
        },
        (err, stdout, stderr) =>
          resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) }),
      );
    });
  }

  async isRepo(dir: string): Promise<boolean> {
    const r = await this.run(['rev-parse', '--is-inside-work-tree'], dir);
    return r.ok && r.stdout.trim() === 'true';
  }

  /** Ensure `dir` is a git repo with at least one commit (so branches/worktrees work). */
  async ensureRepo(dir: string): Promise<void> {
    if (!(await this.isRepo(dir))) {
      await this.run(['init'], dir);
    }
    // Guarantee a HEAD commit exists.
    const head = await this.run(['rev-parse', '--verify', 'HEAD'], dir);
    if (!head.ok) {
      const status = await this.run(['status', '--porcelain'], dir);
      if (status.stdout.trim().length === 0) {
        // Empty repo: seed a keep file so we have a base commit to branch from.
        fs.writeFileSync(path.join(dir, '.ateam-keep'), 'ateam workspace\n');
      }
      await this.run(['add', '-A'], dir);
      await this.commit(dir, 'ateam: initial snapshot');
    }
  }

  private async commit(dir: string, message: string): Promise<{ ok: boolean }> {
    const r = await this.run(
      ['-c', 'user.name=ateam', '-c', 'user.email=ateam@local', 'commit', '-m', message],
      dir,
    );
    return { ok: r.ok };
  }

  /** Sanitized epic branch name. */
  branchFor(epicId: string): string {
    return `ateam/epic-${epicId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24)}`;
  }

  private worktreePath(projectId: string, epicId: string): string {
    return path.join(this.worktreeRoot, projectId, epicId);
  }

  /** Create (or reuse) an isolated worktree on a fresh epic branch. */
  async createEpicWorktree(
    repoDir: string,
    projectId: string,
    epicId: string,
  ): Promise<{ branch: string; path: string }> {
    await this.ensureRepo(repoDir);
    const branch = this.branchFor(epicId);
    const wt = this.worktreePath(projectId, epicId);
    fs.mkdirSync(path.dirname(wt), { recursive: true });

    // Clean any stale worktree registration/dir from a previous run.
    if (fs.existsSync(wt)) {
      await this.run(['worktree', 'remove', '--force', wt], repoDir);
      fs.rmSync(wt, { recursive: true, force: true });
    }
    await this.run(['worktree', 'prune'], repoDir);

    const branchExists = (await this.run(['rev-parse', '--verify', branch], repoDir)).ok;
    const add = branchExists
      ? await this.run(['worktree', 'add', wt, branch], repoDir)
      : await this.run(['worktree', 'add', '-b', branch, wt, 'HEAD'], repoDir);
    if (!add.ok) throw new Error(`git worktree add failed: ${add.stderr.trim()}`);
    return { branch, path: wt };
  }

  /** Stage everything in the worktree and commit if there are changes. */
  async commitWork(
    worktreePath: string,
    message: string,
  ): Promise<{ committed: boolean; hash: string | null }> {
    // Safety: only ever commit inside a managed worktree under worktreeRoot.
    const abs = path.resolve(worktreePath);
    if (!abs.startsWith(this.worktreeRoot + path.sep) && abs !== this.worktreeRoot) {
      return { committed: false, hash: null };
    }
    await this.run(['add', '-A'], worktreePath);
    const status = await this.run(['status', '--porcelain'], worktreePath);
    if (status.stdout.trim().length === 0) return { committed: false, hash: null };
    const c = await this.commit(worktreePath, message);
    if (!c.ok) return { committed: false, hash: null };
    const hash = (await this.run(['rev-parse', 'HEAD'], worktreePath)).stdout.trim();
    return { committed: true, hash };
  }

  /**
   * Whether the worktree has real, deliverable changes — i.e. any modified path
   * OUTSIDE ateam's own bookkeeping (`.ateam/`). Used to reject "empty" build
   * tasks where the agent narrated but produced no code.
   */
  async hasRealChanges(worktreePath: string): Promise<boolean> {
    const abs = path.resolve(worktreePath);
    if (!abs.startsWith(this.worktreeRoot + path.sep) && abs !== this.worktreeRoot) return false;
    const status = await this.run(['status', '--porcelain'], worktreePath);
    return status.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .some((l) => {
        // porcelain lines look like "XY path" or "XY old -> new"; take the path.
        const p = l
          .replace(/^..\s+/, '')
          .replace(/^.*->\s*/, '')
          .replace(/^"|"$/g, '');
        return p.length > 0 && !p.startsWith('.ateam/') && p !== '.ateam';
      });
  }

  async currentBranch(dir: string): Promise<string> {
    return (await this.run(['rev-parse', '--abbrev-ref', 'HEAD'], dir)).stdout.trim();
  }

  async listBranches(repoDir: string): Promise<string[]> {
    const r = await this.run(['branch', '--format=%(refname:short)'], repoDir);
    return r.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** Diff of committed epic-branch work vs the base it branched from. */
  async diffStat(worktreePath: string): Promise<string> {
    const r = await this.run(['diff', '--stat', 'HEAD~1', 'HEAD'], worktreePath);
    return r.ok ? r.stdout.trim() : '';
  }

  /** Full diff of an epic branch vs the current base branch, capped for display. */
  async branchDiff(repoDir: string, branch: string): Promise<string> {
    const base = await this.currentBranch(repoDir);
    const r = await this.run(['diff', `${base}...${branch}`], repoDir);
    const out = r.ok ? r.stdout : '';
    return out.length > 20000 ? `${out.slice(0, 20000)}\n…(truncated)` : out;
  }

  /** Merge an epic branch into the base branch (fast-forward or no-ff). Phase 4 uses this. */
  async mergeEpic(repoDir: string, branch: string): Promise<{ ok: boolean; detail: string }> {
    const base = await this.currentBranch(repoDir);
    const r = await this.run(['merge', '--no-ff', '-m', `ateam: merge ${branch}`, branch], repoDir);
    return { ok: r.ok, detail: r.ok ? `merged ${branch} into ${base}` : r.stderr.trim() };
  }

  async removeWorktree(repoDir: string, worktreePath: string): Promise<void> {
    await this.run(['worktree', 'remove', '--force', worktreePath], repoDir);
    if (fs.existsSync(worktreePath)) fs.rmSync(worktreePath, { recursive: true, force: true });
  }

  /** Remove all worktrees created for a project (best-effort cleanup). */
  removeProjectWorktrees(projectId: string): void {
    const dir = path.join(this.worktreeRoot, projectId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
}
