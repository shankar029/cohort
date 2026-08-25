import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface TestRunResult {
  /** Whether a runnable command existed and was executed. */
  ran: boolean;
  /** Whether the command exited 0. Only meaningful when `ran` is true. */
  passed: boolean;
  /** The resolved command (empty when nothing was runnable). */
  command: string;
  /** Captured combined stdout/stderr (tail-bounded). */
  output: string;
}

/**
 * Kill a child and its ENTIRE descendant tree without ever touching the parent
 * (the ateam server). A `shell:true` child on Windows is a cmd.exe wrapper whose
 * grandchildren survive a plain `child.kill()`, so use `taskkill /t` to tear down
 * the tree. On POSIX the child is spawned `detached`, so it is its own process-
 * group leader and we kill the whole group via the negative pid — this reaps any
 * test-runner workers it spawned and can never signal an ancestor.
 */
function killTree(child: import('node:child_process').ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      // Negative pid => the whole process group (child is the group leader).
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
  } catch {
    /* already gone */
  }
}

/**
 * Resolve the verification command used for QA sign-off. An explicit `override`
 * (project `testCommand`) always wins; otherwise the best test-ish npm script in
 * `dir`'s package.json is used (`test:e2e` > `e2e` > `test`), ignoring the npm
 * "no test specified" placeholder. Returns null when nothing is runnable.
 */
export function resolveTestCommand(dir: string, override?: string): string | null {
  const ov = override?.trim();
  if (ov) return ov;
  try {
    const pkgPath = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgPath)) return null;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    for (const name of ['test:e2e', 'e2e', 'test']) {
      const body = scripts[name];
      if (typeof body === 'string' && body.trim() && !/no test specified/i.test(body)) {
        return `npm run ${name} --silent`;
      }
    }
  } catch {
    /* unreadable/invalid package.json */
  }
  return null;
}

/**
 * Run the project's test command in `dir` and report the result. The child is
 * isolated so a heavy or crashing suite can never take the server down:
 * - its own process group (POSIX `detached`) / taskkill tree (Windows), so the
 *   whole worker tree is reaped and the kill never hits an ancestor;
 * - no inherited stdin (`ignore`), so a suite that reads input can't hang;
 * - `CI=1` for deterministic, non-interactive runs; `windowsHide` for no popups.
 * Bounded by a timeout so a hanging suite can never stall the caller. This never
 * throws — every failure path resolves. `ran: false` means there was nothing
 * runnable to verify (no override, no test script).
 */
export function runProjectTests(
  dir: string,
  override?: string,
  timeoutMs = 240_000,
): Promise<TestRunResult> {
  const command = resolveTestCommand(dir, override);
  if (!command) return Promise.resolve({ ran: false, passed: false, command: '', output: '' });
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const cap = (b: Buffer): void => {
      out += b.toString();
      if (out.length > 20_000) out = out.slice(-20_000);
    };
    let child: import('node:child_process').ChildProcess;
    try {
      child = spawn(command, {
        cwd: dir,
        shell: true,
        env: { ...process.env, CI: '1' },
        // POSIX: own process group so the whole worker tree is reapable via the
        // negative pid and our kill can never hit an ancestor. Windows: `detached`
        // breaks piped stdio, so we isolate via `taskkill /t` (kills the tree) plus
        // a hidden window instead.
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ ran: false, passed: false, command, output: String(err) });
      return;
    }
    const done = (r: TestRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      killTree(child);
      done({ ran: true, passed: false, command, output: out + '\n[timed out]' });
    }, timeoutMs);
    child.stdout?.on('data', cap);
    child.stderr?.on('data', cap);
    child.on('error', (err) => {
      killTree(child);
      done({ ran: false, passed: false, command, output: out + '\n' + String(err) });
    });
    child.on('exit', (code) => {
      done({ ran: true, passed: code === 0, command, output: out });
    });
  });
}
