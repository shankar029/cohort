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
  return resolveScript(dir, ['test:e2e', 'e2e', 'test']);
}

/**
 * Resolve the STATIC build/compile check used for the per-task verification gate
 * (does the code the agent just wrote still compile?). An explicit `override`
 * (project `buildCommand`) always wins; otherwise the best build-ish npm script in
 * `dir`'s package.json is used (`typecheck` > `build` > `compile`). Prefers
 * `typecheck` because it is pure and side-effect-free. Returns null when nothing
 * is runnable (e.g. a script-less vanilla project), which makes the gate a no-op.
 */
export function resolveBuildCommand(dir: string, override?: string): string | null {
  const ov = override?.trim();
  if (ov) return ov;
  return resolveScript(dir, ['typecheck', 'type-check', 'build', 'compile']);
}

/** Pick the first present, non-placeholder npm script from `names`. */
function resolveScript(dir: string, names: string[]): string | null {
  try {
    const pkgPath = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgPath)) return null;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    for (const name of names) {
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
  return runResolved(resolveTestCommand(dir, override), dir, timeoutMs);
}

/**
 * Run the project's static build/compile check in `dir` (see resolveBuildCommand).
 * Same isolation + timeout guarantees as runProjectTests; `ran: false` means
 * there was no build script to run (graceful no-op).
 */
export function runProjectBuild(
  dir: string,
  override?: string,
  timeoutMs = 240_000,
): Promise<TestRunResult> {
  return runResolved(resolveBuildCommand(dir, override), dir, timeoutMs);
}

/**
 * Resolve the deterministic epic-level ACCEPTANCE PROBE command (MAJOR-1). An
 * explicit `override` (project `acceptanceCommand`) always wins; otherwise, if a
 * committed `.ateam/acceptance.mjs` probe exists in `dir` (authored from the spec
 * by the QA/architect), run it with Node. Returns null when neither is present,
 * which makes the acceptance-probe gate a graceful no-op (`skip`, never blocking).
 * The probe is a spec-derived contract check INDEPENDENT of the builders' own
 * unit tests, so it catches a green-but-wrong-contract delivery.
 */
export function resolveAcceptanceProbe(dir: string, override?: string): string | null {
  const ov = override?.trim();
  if (ov) return ov;
  try {
    if (fs.existsSync(path.join(dir, '.ateam', 'acceptance.mjs'))) {
      return 'node .ateam/acceptance.mjs';
    }
  } catch {
    /* fs unavailable */
  }
  return null;
}

/**
 * Run the epic's acceptance probe in `dir` (the integrated epic clone). Same
 * isolation + timeout guarantees as runProjectTests; `ran: false` means there was
 * no probe to run (graceful no-op => the gate records `skip`). `passed` reflects
 * exit code 0.
 */
export function runAcceptanceProbe(
  dir: string,
  override?: string,
  timeoutMs = 240_000,
): Promise<TestRunResult> {
  return runResolved(resolveAcceptanceProbe(dir, override), dir, timeoutMs);
}

/**
 * Ensure a project directory's dependencies are installed before a build/test
 * gate runs there. The integrated epic clone (and freshly-forked task clones)
 * start with source only - `node_modules` is git-ignored, never committed - so a
 * project whose build/test command needs installed tooling (`tsc`, `vitest`, `tsx`)
 * would spuriously fail the gate. This installs deps ONLY when:
 *   - a package.json exists AND declares dependencies/devDependencies, AND
 *   - `node_modules` is absent (so it is a cheap no-op once installed).
 * Prefers `npm ci` when a lockfile is present, else `npm install`. Best-effort:
 * a script-less / dependency-less project is a graceful no-op (`ran: false`), and
 * an install failure is reported but left for the downstream gate to surface.
 */
export function ensureDependencies(dir: string, timeoutMs = 300_000): Promise<TestRunResult> {
  try {
    const pkgPath = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      return Promise.resolve({ ran: false, passed: true, command: '', output: '' });
    }
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const depCount =
      Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length;
    if (depCount === 0) {
      return Promise.resolve({ ran: false, passed: true, command: '', output: '' });
    }
    if (fs.existsSync(path.join(dir, 'node_modules'))) {
      return Promise.resolve({
        ran: false,
        passed: true,
        command: '',
        output: 'node_modules present',
      });
    }
    const cmd = fs.existsSync(path.join(dir, 'package-lock.json')) ? 'npm ci' : 'npm install';
    return runResolved(cmd, dir, timeoutMs);
  } catch {
    return Promise.resolve({ ran: false, passed: true, command: '', output: '' });
  }
}

function runResolved(
  command: string | null,
  dir: string,
  timeoutMs: number,
): Promise<TestRunResult> {
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
