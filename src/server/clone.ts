import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Standalone git-clone helper for the "import a project by URL" flow.
 *
 * Deliberately kept OFF `GitService`: that class is scoped to managed epic/task
 * clones under its `worktreeRoot` (its whole invariant), whereas an import clone
 * writes into a user-chosen directory anywhere on the local disk. Mixing the two
 * would break `GitService`'s single responsibility, so this is a small module
 * function the import service imports directly — no `GitService` instance, and
 * no wiring change to `buildApp`.
 *
 * Like `GitService.run`, it never throws on a non-zero exit: it resolves a
 * `{ ok, path, stderr }` result so the caller can map a failure to a clear HTTP
 * error. `GIT_TERMINAL_PROMPT=0` forces git to FAIL FAST instead of hanging on a
 * credential prompt for a private/auth-required repo.
 */
export async function cloneRepoToDir(
  url: string,
  parentDir: string,
  name: string,
): Promise<{ ok: boolean; path: string; stderr: string }> {
  const parent = path.resolve(parentDir);
  const targetPath = path.join(parent, name);
  return new Promise((resolve) => {
    execFile(
      'git',
      ['clone', '--', url, name],
      {
        cwd: parent,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_AUTHOR_NAME: 'ateam',
          GIT_AUTHOR_EMAIL: 'ateam@local',
          GIT_COMMITTER_NAME: 'ateam',
          GIT_COMMITTER_EMAIL: 'ateam@local',
        },
      },
      (err, _stdout, stderr) => {
        if (err) {
          // Best-effort cleanup of any partial checkout git left behind, so a
          // failed import never leaves a half-cloned directory on disk.
          try {
            fs.rmSync(targetPath, { recursive: true, force: true });
          } catch {
            /* ignore cleanup failure */
          }
          resolve({ ok: false, path: targetPath, stderr: String(stderr || err.message) });
          return;
        }
        resolve({ ok: true, path: targetPath, stderr: String(stderr) });
      },
    );
  });
}
