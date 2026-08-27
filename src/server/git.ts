import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Thin wrapper over the git CLI. Isolates each epic in its OWN local clone
 * (a full checkout with its own `.git`), so agents working on different epics
 * never share a filesystem — and, critically, so the Copilot runtime resolves
 * the workspace root to the epic checkout rather than following a linked
 * worktree's `.git` file back to the main repository. All operations are scoped
 * to managed clones under `worktreeRoot`; the project's `main` is never touched
 * until an explicit merge, and nothing is pushed to a remote.
 */
export class GitService {
  private readonly worktreeRoot: string;
  constructor(worktreeRoot: string) {
    // Always absolute so checkout paths can never resolve inside a project/app repo.
    this.worktreeRoot = path.resolve(worktreeRoot);
  }

  /** Absolute root under which all managed epic clones live. */
  get root(): string {
    return this.worktreeRoot;
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

  /**
   * Create (or recreate) an isolated LOCAL CLONE of the repo on a fresh epic
   * branch. A clone (not a linked worktree) is used deliberately: it has its own
   * `.git` directory, so the Copilot runtime roots file operations inside the
   * epic checkout instead of following a worktree's `.git` file back to the main
   * repo (which caused agent edits to land in the wrong directory).
   */
  async createEpicWorktree(
    repoDir: string,
    projectId: string,
    epicId: string,
  ): Promise<{ branch: string; path: string }> {
    await this.ensureRepo(repoDir);
    const branch = this.branchFor(epicId);
    const dir = this.worktreePath(projectId, epicId);
    fs.mkdirSync(path.dirname(dir), { recursive: true });

    // Clean any stale checkout from a previous run.
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });

    // Full local clone (own object store + .git), so root resolution is correct.
    const cloned = await this.run(
      ['clone', '--no-hardlinks', '--quiet', repoDir, dir],
      path.dirname(dir),
    );
    if (!cloned.ok) throw new Error(`git clone failed: ${cloned.stderr.trim()}`);

    // Branch the epic off the clone's HEAD (the base branch it was cloned from).
    const co = await this.run(['checkout', '-b', branch], dir);
    if (!co.ok) {
      // Branch may already exist from a prior run's history; check it out.
      const existing = await this.run(['checkout', branch], dir);
      if (!existing.ok) throw new Error(`git checkout epic branch failed: ${co.stderr.trim()}`);
    }
    return { branch, path: dir };
  }

  /** Stage everything in the epic clone and commit if there are changes. */
  async commitWork(
    worktreePath: string,
    message: string,
  ): Promise<{ committed: boolean; hash: string | null }> {
    // Safety: only ever commit inside a managed clone under worktreeRoot.
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
  /** Working-tree paths changed vs HEAD (excludes ateam bookkeeping). */
  async changedFiles(worktreePath: string): Promise<string[]> {
    const abs = path.resolve(worktreePath);
    if (!abs.startsWith(this.worktreeRoot + path.sep) && abs !== this.worktreeRoot) return [];
    const status = await this.run(['status', '--porcelain'], worktreePath);
    return status.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) =>
        // porcelain lines look like "XY path" or "XY old -> new"; take the path.
        l
          .replace(/^..\s+/, '')
          .replace(/^.*->\s*/, '')
          .replace(/^"|"$/g, ''),
      )
      .filter((p) => p.length > 0 && !p.startsWith('.ateam/') && p !== '.ateam');
  }

  async hasRealChanges(worktreePath: string): Promise<boolean> {
    return (await this.changedFiles(worktreePath)).length > 0;
  }

  /** Repo-relative tracked file paths (via `git ls-files`). */
  async listTrackedFiles(repoDir: string): Promise<string[]> {
    const r = await this.run(['ls-files'], repoDir);
    return r.ok
      ? r.stdout
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
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

  /** Diff of committed epic-branch work vs the base it was cloned from. */
  async diffStat(worktreePath: string): Promise<string> {
    const r = await this.run(['diff', '--stat', 'HEAD~1', 'HEAD'], worktreePath);
    return r.ok ? r.stdout.trim() : '';
  }

  /** Commits on the epic branch that are ahead of the base it was cloned from. */
  async commitsAhead(
    checkoutPath: string,
    base: string,
  ): Promise<Array<{ hash: string; subject: string; author: string; date: string }>> {
    const ref = base ? `origin/${base}` : 'origin/HEAD';
    const fmt = '%H%x1f%s%x1f%an%x1f%aI';
    let r = await this.run(['log', `${ref}..HEAD`, `--pretty=format:${fmt}`], checkoutPath);
    if (!r.ok)
      r = await this.run(['log', `origin/HEAD..HEAD`, `--pretty=format:${fmt}`], checkoutPath);
    if (!r.ok) return [];
    return r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [hash = '', subject = '', author = '', date = ''] = l.split('\x1f');
        return { hash, subject, author, date };
      });
  }

  private parseNumstat(out: string): Array<{ path: string; added: number; removed: number }> {
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const parts = l.split('\t');
        const added = parts[0] === '-' ? -1 : Number(parts[0] ?? 0);
        const removed = parts[1] === '-' ? -1 : Number(parts[1] ?? 0);
        const p = (parts[2] ?? '').replace(/^.*=>\s*/, '').replace(/^"|"$/g, '');
        return {
          path: p,
          added: Number.isFinite(added) ? added : 0,
          removed: Number.isFinite(removed) ? removed : 0,
        };
      })
      .filter((f) => f.path.length > 0);
  }

  /** Files changed on the epic branch vs its base, with +/- line counts. */
  async filesChanged(
    checkoutPath: string,
    base: string,
  ): Promise<Array<{ path: string; added: number; removed: number }>> {
    const ref = base ? `origin/${base}` : 'origin/HEAD';
    let r = await this.run(['diff', '--numstat', `${ref}...HEAD`], checkoutPath);
    if (!r.ok) r = await this.run(['diff', '--numstat', 'origin/HEAD...HEAD'], checkoutPath);
    return r.ok ? this.parseNumstat(r.stdout) : [];
  }

  /** Files touched by a single commit, with +/- line counts. */
  async commitFiles(
    checkoutPath: string,
    hash: string,
  ): Promise<Array<{ path: string; added: number; removed: number }>> {
    const r = await this.run(['show', '--numstat', '--format=', hash], checkoutPath);
    return r.ok ? this.parseNumstat(r.stdout) : [];
  }

  /**
   * Full diff of an epic clone's branch vs the base branch it was cloned from,
   * capped for display. Runs inside the clone (which has origin/<base>).
   */
  async branchDiff(checkoutPath: string, base: string): Promise<string> {
    const ref = base ? `origin/${base}` : 'origin/HEAD';
    let r = await this.run(['diff', `${ref}...HEAD`], checkoutPath);
    if (!r.ok) r = await this.run(['diff', 'origin/HEAD...HEAD'], checkoutPath);
    const out = r.ok ? r.stdout : '';
    return out.length > 20000 ? `${out.slice(0, 20000)}\n…(truncated)` : out;
  }

  /**
   * Merge an epic clone's branch into the base branch of the main repo. The epic
   * branch is fetched from the clone into the main repo first, then merged
   * (--no-ff). Nothing is pushed to any remote.
   */
  async mergeEpic(
    repoDir: string,
    checkoutPath: string,
    branch: string,
  ): Promise<{ ok: boolean; detail: string }> {
    const base = await this.currentBranch(repoDir);
    if (checkoutPath && fs.existsSync(checkoutPath)) {
      const fetched = await this.run(['fetch', checkoutPath, `${branch}:${branch}`], repoDir);
      if (!fetched.ok) return { ok: false, detail: `fetch failed: ${fetched.stderr.trim()}` };
    }
    const r = await this.run(['merge', '--no-ff', '-m', `ateam: merge ${branch}`, branch], repoDir);
    return { ok: r.ok, detail: r.ok ? `merged ${branch} into ${base}` : r.stderr.trim() };
  }

  /** Remove an epic clone directory (best-effort). */
  async removeWorktree(_repoDir: string, worktreePath: string): Promise<void> {
    const abs = path.resolve(worktreePath);
    if (!abs.startsWith(this.worktreeRoot + path.sep)) return;
    if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true });
  }

  /** Remove all worktrees created for a project (best-effort cleanup). */
  removeProjectWorktrees(projectId: string): void {
    const dir = path.join(this.worktreeRoot, projectId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }

  /**
   * Find the merge commit that landed an epic branch, identified by the
   * deterministic message `mergeEpic` writes (`ateam: merge <branch>`). Returns
   * the newest matching commit hash, or null if the branch was never merged.
   */
  async findEpicMergeCommit(repoDir: string, branch: string): Promise<string | null> {
    if (!branch) return null;
    const r = await this.run(
      ['log', '--all', '--format=%H', '--max-count=1', `--grep=^ateam: merge ${branch}$`],
      repoDir,
    );
    const hash = r.stdout.trim().split('\n')[0]?.trim();
    return r.ok && hash ? hash : null;
  }

  /**
   * Revert a merge commit on the current base branch, undoing everything the epic
   * landed. Reversible (it is itself a commit) and local-only. Aborts cleanly on
   * conflict rather than leaving a half-applied revert.
   */
  async revertMerge(repoDir: string, commit: string): Promise<{ ok: boolean; detail: string }> {
    const dirty = await this.run(['status', '--porcelain'], repoDir);
    if (dirty.stdout.trim().length > 0) {
      return { ok: false, detail: 'working tree has uncommitted changes; revert skipped' };
    }
    const r = await this.run(['revert', '--no-edit', '-m', '1', commit], repoDir);
    if (!r.ok) {
      await this.run(['revert', '--abort'], repoDir);
      return { ok: false, detail: r.stderr.trim() || 'revert failed' };
    }
    return { ok: true, detail: `reverted merge ${commit.slice(0, 8)}` };
  }

  /** Delete a local branch (best-effort). Used when discarding an epic. */
  async deleteBranch(repoDir: string, branch: string): Promise<void> {
    if (!branch) return;
    await this.run(['branch', '-D', branch], repoDir);
  }
}
