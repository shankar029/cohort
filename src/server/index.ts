import fs from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';
import fastifyStatic from '@fastify/static';
import { loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { Store } from './db/store.js';
import { Bus } from './bus.js';
import { OrchestratorManager } from './orchestrator.js';
import { SchedulerService } from './scheduler.js';
import { GitService } from './git.js';
import { SessionRecorder } from './sessionRecorder.js';
import { buildApp } from './app.js';
import { FakeCopilotAdapter } from './agents/fakeAdapter.js';
import { RealCopilotAdapter } from './agents/realAdapter.js';
import type { CopilotAdapter } from './agents/adapter.js';

// A long-running local server must never die because one agent turn threw or a
// child process hiccuped. Log and keep serving instead of crashing the whole app.
process.on('unhandledRejection', (reason) => {
  process.stderr.write(
    `[unhandledRejection] ${reason instanceof Error ? reason.stack : String(reason)}\n`,
  );
});
process.on('uncaughtException', (err) => {
  process.stderr.write(`[uncaughtException] ${err instanceof Error ? err.stack : String(err)}\n`);
});

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const store = new Store(db);
  const bus = new Bus();
  const scheduler = new SchedulerService();
  const git = new GitService(config.worktreeRoot, config.commitStyle);
  const recorder = new SessionRecorder(config.recordingsDir);
  const adapter: CopilotAdapter = config.fakeSdk
    ? new FakeCopilotAdapter()
    : new RealCopilotAdapter();
  const orchestrators = new OrchestratorManager({
    store,
    bus,
    adapter,
    skillHomeRoots: config.skillHomeRoots,
    scheduler,
    git,
    recorder,
  });

  const app = buildApp({
    store,
    bus,
    orchestrators,
    recorder,
    config: { defaultModel: config.defaultModel, skillHomeRoots: config.skillHomeRoots, recordSessions: config.recordSessions },
    listModels: () => adapter.listModels(),
  });

  // Serve the built SPA in production.
  if (config.isProduction && fs.existsSync(config.webDistDir)) {
    await app.register(fastifyStatic, { root: config.webDistDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url && req.raw.url.startsWith('/api')) {
        reply.status(404).send({ error: 'Not found' });
        return;
      }
      reply.sendFile('index.html');
    });
  }

  await app.ready();

  // Re-arm any scheduled/recurring work items persisted from previous runs.
  orchestrators.resumeAll(store.listProjects().map((p) => p.id));

  // WebSocket server for live event streaming.
  const wss = new WebSocketServer({ server: app.server, path: '/ws' });
  wss.on('error', (err) => process.stderr.write(`[ws] server error: ${String(err)}\n`));
  wss.on('connection', (socket: WebSocket) => {
    socket.on('error', () => undefined); // ignore per-socket transport errors
    const unsubscribe = bus.subscribe((message) => {
      try {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
      } catch {
        /* socket went away mid-send; the close handler will clean up */
      }
    });
    socket.on('close', unsubscribe);
    socket.on('error', unsubscribe);
    try {
      socket.send(JSON.stringify({ type: 'hello', adapter: adapter.name }));
    } catch {
      /* ignore */
    }
  });

  await app.listen({ port: config.port, host: '0.0.0.0' });
  const banner = `\n  Cohort server ready\n  → http://localhost:${config.port}  (adapter: ${adapter.name})\n`;
  process.stdout.write(banner);

  // Warm the models cache in the background so the first model picker in the UI
  // is instant instead of waiting ~5s on the cold SDK connect + models.list RPC.
  // Retries with backoff so that if the Copilot SDK isn't authenticated yet, the
  // list still populates automatically once the user signs in — the server keeps
  // running the whole time.
  warmModels(adapter);
  if (!config.isProduction) {
    process.stdout.write(
      `  → web dev server: run \`npm run dev:web\` (Vite) at http://localhost:5319\n`,
    );
  }

  const shutdown = async (): Promise<void> => {
    wss.close();
    await orchestrators.shutdown().catch(() => undefined);
    await app.close().catch(() => undefined);
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});

/**
 * Warm the model list in the background, retrying with backoff. A common startup
 * state is "Copilot not authenticated yet" — rather than failing once and leaving
 * an empty list, keep retrying quietly so the picker fills in as soon as the user
 * signs in. The server stays up regardless.
 */
function warmModels(adapter: { listModels: () => Promise<string[]> }): void {
  let attempt = 0;
  let warnedAuth = false;
  const tick = (): void => {
    attempt++;
    adapter
      .listModels()
      .then((models) => {
        if (models.length) process.stdout.write(`  → ${models.length} models available\n`);
        else if (attempt < 30) setTimeout(tick, backoff(attempt));
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (/not authenticated|authenticate first/i.test(msg)) {
          if (!warnedAuth) {
            warnedAuth = true;
            process.stderr.write(
              `  ⚠ Copilot is not authenticated yet — sign in with the Copilot CLI ` +
                `(\`copilot\` or \`gh copilot\`). The app keeps running and the model list ` +
                `will populate automatically once you're signed in.\n`,
            );
          }
        } else {
          process.stderr.write(`[models] warm-up failed (attempt ${attempt}): ${msg}\n`);
        }
        if (attempt < 30) setTimeout(tick, backoff(attempt));
      });
  };
  const backoff = (n: number): number => Math.min(30_000, 1_000 * 2 ** Math.min(n, 5));
  tick();
}
