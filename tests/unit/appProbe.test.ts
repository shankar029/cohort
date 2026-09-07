import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeApp } from '../../src/server/appProbe.js';

/** Write a throwaway dir with a tiny Node HTTP server that reads PORT from env. */
function fixtureDir(serverSource: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
  fs.writeFileSync(path.join(dir, 'server.js'), serverSource);
  return dir;
}

/** Best-effort recursive delete; the just-killed child may briefly hold the dir. */
async function safeRm(dir: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

const HEALTHY = `
const http = require('node:http');
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ hello: 'world' }));
}).listen(port, () => console.log('listening on ' + port));
`;

describe('probeApp', () => {
  it('boots a server, confirms readiness via URL, runs a probe, and tears it down', async () => {
    const dir = fixtureDir(HEALTHY);
    const port = 34517;
    const res = await probeApp({
      startCommand: 'node server.js',
      cwd: dir,
      env: { PORT: String(port) },
      readyUrl: `http://127.0.0.1:${port}/health`,
      probeCommands: [`node -e "fetch('http://127.0.0.1:${port}/').then(r=>r.json()).then(j=>{if(j.hello!=='world')process.exit(1)})"`],
      timeoutSeconds: 20,
    });
    expect(res.booted).toBe(true);
    expect(res.ready).toBe(true);
    expect(res.probes).toHaveLength(1);
    expect(res.probes[0]?.exitCode).toBe(0);
    // The port must be free again (server was torn down): a fresh boot on the same
    // port still succeeds and tears down cleanly.
    await new Promise((r) => setTimeout(r, 500));
    const stillUp = await probeApp({
      startCommand: 'node server.js',
      cwd: dir,
      env: { PORT: String(port) },
      readyUrl: `http://127.0.0.1:${port}/health`,
      timeoutSeconds: 8,
    });
    expect(stillUp.booted).toBe(true);
    expect(stillUp.ready).toBe(true);
    await safeRm(dir);
  }, 40000);

  it('reports not-ready when the app exits early', async () => {
    const dir = fixtureDir(`process.exit(1);`);
    const res = await probeApp({
      startCommand: 'node server.js',
      cwd: dir,
      readyUrl: 'http://127.0.0.1:34599/health',
      timeoutSeconds: 6,
    });
    expect(res.ready).toBe(false);
    expect(res.note).toMatch(/exited|ready/i);
    await safeRm(dir);
  }, 20000);

  it('times out cleanly when readiness never passes', async () => {
    const dir = fixtureDir(HEALTHY);
    const res = await probeApp({
      startCommand: 'node server.js',
      cwd: dir,
      env: { PORT: '34811' },
      readyUrl: 'http://127.0.0.1:34812/health', // wrong port => never ready
      timeoutSeconds: 4,
    });
    expect(res.booted).toBe(true);
    expect(res.ready).toBe(false);
    await safeRm(dir);
  }, 20000);
});
