// Supervises the Vite dev server so `npm run dev` self-heals.
//
// On Windows, an abrupt WebSocket-proxy teardown can trigger a *native* Node
// crash (exit code 3221226505 / 0xC0000409, STATUS_STACK_BUFFER_OVERRUN) that no
// in-process handler (uncaughtException, etc.) can catch — the process is gone.
// Rather than leaving the web dev server dead until the user notices, respawn it
// automatically with a small backoff. Clean exits (code 0) and Ctrl+C are
// respected and do not restart.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
// Run Vite's JS entrypoint with the current Node binary — avoids Windows `.cmd`
// spawn restrictions and shell quoting entirely. Vite doesn't export its bin via
// `exports`, so resolve it relative to the package's own package.json.
const vitePkg = require.resolve('vite/package.json');
const viteBin = path.join(path.dirname(vitePkg), require('vite/package.json').bin.vite);
const args = process.argv.slice(2);

let shuttingDown = false;
let restarts = 0;

function start() {
  const startedAt = Date.now();
  const child = spawn(process.execPath, [viteBin, ...args], { stdio: 'inherit' });

  child.on('exit', (code, signal) => {
    if (shuttingDown || signal === 'SIGINT' || signal === 'SIGTERM') return;
    if (code === 0) {
      process.exit(0); // Vite stopped cleanly (e.g. dev server closed on purpose).
      return;
    }
    // Reset the backoff if the server had been running a while before crashing.
    if (Date.now() - startedAt > 10_000) restarts = 0;
    restarts++;
    const delay = Math.min(3_000, 300 * restarts);
    process.stderr.write(
      `\n[dev:web] Vite exited with code ${code}${signal ? ` (${signal})` : ''}. ` +
        `Restarting in ${delay}ms (restart #${restarts})…\n`,
    );
    setTimeout(start, delay);
  });

  child.on('error', (err) => {
    process.stderr.write(`[dev:web] failed to spawn Vite: ${err.message}\n`);
    if (!shuttingDown && restarts < 50) setTimeout(start, 1_000);
  });

  const stop = () => {
    shuttingDown = true;
    child.kill('SIGINT');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

start();
