import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { killProcessTree } from './qaGate.js';

export interface AppProbeInput {
  /** The command that starts the app/server, e.g. `node server.js`. */
  startCommand: string;
  /** Directory to run in (the agent's working directory). */
  cwd: string;
  /** Extra env vars for the started process (e.g. `{ PORT: '3000' }`). */
  env?: Record<string, string>;
  /** An HTTP URL polled until it responds (any status = listening). */
  readyUrl?: string;
  /** A shell command polled until it exits 0 (alternative readiness signal). */
  readyCommand?: string;
  /** Commands to run once the app is ready; each output is captured. */
  probeCommands?: string[];
  /** Max seconds to wait for readiness (default 30, capped 120). */
  timeoutSeconds?: number;
}

export interface AppProbeResult {
  /** The start command was spawned and did not immediately fail. */
  booted: boolean;
  /** The readiness signal passed within the timeout. */
  ready: boolean;
  waitedMs: number;
  /** Tail of the server's combined stdout/stderr. */
  serverLog: string;
  probes: Array<{ command: string; exitCode: number | null; output: string }>;
  note: string;
}

const TAIL = 8000;
const clampTail = (s: string): string => (s.length > TAIL ? s.slice(-TAIL) : s);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Spawn a short-lived command, resolve with exit code + captured output. */
function runOnce(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    let child: ChildProcess;
    const cap = (b: Buffer): void => {
      out += b.toString();
      if (out.length > TAIL) out = out.slice(-TAIL);
    };
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        env,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ exitCode: null, output: String(err) });
      return;
    }
    const done = (r: { exitCode: number | null; output: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      killProcessTree(child);
      done({ exitCode: null, output: out + '\n[timed out]' });
    }, timeoutMs);
    child.stdout?.on('data', cap);
    child.stderr?.on('data', cap);
    child.on('error', (err) => done({ exitCode: null, output: out + '\n' + String(err) }));
    child.on('exit', (code) => done({ exitCode: code, output: out }));
  });
}

/** True once the URL answers at all (any HTTP status = the port is listening). */
function urlResponds(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

/**
 * Boot an app in the background, wait until it's ready, run probe commands
 * against it, then ALWAYS tear it down. This gives agents a reliable way to
 * verify a running app without executing a blocking `start` command themselves
 * (which would hang the turn) and without leaking a live process.
 */
export async function probeApp(input: AppProbeInput): Promise<AppProbeResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...(input.env ?? {}) };
  const timeoutMs = Math.max(1, Math.min(120, Number(input.timeoutSeconds) || 30)) * 1000;
  const result: AppProbeResult = {
    booted: false,
    ready: false,
    waitedMs: 0,
    serverLog: '',
    probes: [],
    note: '',
  };

  let server: ChildProcess;
  let log = '';
  const capLog = (b: Buffer): void => {
    log += b.toString();
    if (log.length > TAIL) log = log.slice(-TAIL);
  };
  try {
    server = spawn(input.startCommand, {
      cwd: input.cwd,
      shell: true,
      env,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    result.note = `Failed to spawn start command: ${String(err)}`;
    return result;
  }

  let exitedEarly = false;
  let exitInfo = '';
  server.stdout?.on('data', capLog);
  server.stderr?.on('data', capLog);
  server.on('error', (err) => {
    exitedEarly = true;
    exitInfo = String(err);
  });
  server.on('exit', (code) => {
    exitedEarly = true;
    exitInfo = `start command exited early with code ${code}`;
  });

  try {
    result.booted = true;
    const started = Date.now();
    const deadline = started + timeoutMs;

    // Wait for readiness. With no explicit signal, give it a short settle.
    if (!input.readyUrl && !input.readyCommand) {
      await sleep(Math.min(3000, timeoutMs));
      result.ready = !exitedEarly;
    } else {
      while (Date.now() < deadline && !exitedEarly) {
        const ok = input.readyUrl
          ? await urlResponds(input.readyUrl, 2000)
          : (await runOnce(input.readyCommand as string, input.cwd, env, 10_000)).exitCode === 0;
        if (ok) {
          result.ready = true;
          break;
        }
        await sleep(1000);
      }
    }
    result.waitedMs = Date.now() - started;

    if (exitedEarly) {
      result.note = exitInfo || 'The app process exited before it became ready.';
    } else if (!result.ready) {
      result.note = `App did not become ready within ${timeoutMs / 1000}s.`;
    } else {
      // Ready — run the probes.
      for (const command of input.probeCommands ?? []) {
        const r = await runOnce(command, input.cwd, env, 30_000);
        result.probes.push({ command, exitCode: r.exitCode, output: clampTail(r.output) });
      }
      result.note = result.probes.length
        ? 'App booted; probes executed.'
        : 'App booted and became ready (no probe commands given).';
    }
  } finally {
    killProcessTree(server);
    result.serverLog = clampTail(log);
  }
  return result;
}
