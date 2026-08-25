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
 * Kill a child and its descendants. A `shell:true` child on Windows is a
 * cmd.exe wrapper whose grandchildren survive a plain `child.kill()`, so use
 * taskkill to tear down the whole tree; SIGKILL elsewhere.
 */
function killTree(child: import('node:child_process').ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
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
 * Run the project's test command in `dir` and report the result. Bounded by a
 * timeout so a hanging suite can never stall the caller. `ran: false` means
 * there was nothing runnable to verify (no override, no test script).
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
    const cap = (b: Buffer): void => {
      out += b.toString();
      if (out.length > 20_000) out = out.slice(-20_000);
    };
    let child: import('node:child_process').ChildProcess;
    try {
      child = spawn(command, { cwd: dir, shell: true, env: process.env });
    } catch (err) {
      resolve({ ran: false, passed: false, command, output: String(err) });
      return;
    }
    const timer = setTimeout(() => {
      killTree(child);
      resolve({ ran: true, passed: false, command, output: out + '\n[timed out]' });
    }, timeoutMs);
    child.stdout?.on('data', cap);
    child.stderr?.on('data', cap);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ran: false, passed: false, command, output: String(err) });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ ran: true, passed: code === 0, command, output: out });
    });
  });
}
