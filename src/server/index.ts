import fs from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';
import fastifyStatic from '@fastify/static';
import { loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { Store } from './db/store.js';
import { Bus } from './bus.js';
import { OrchestratorManager } from './orchestrator.js';
import { buildApp } from './app.js';
import { FakeCopilotAdapter } from './agents/fakeAdapter.js';
import { RealCopilotAdapter } from './agents/realAdapter.js';
import type { CopilotAdapter } from './agents/adapter.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const store = new Store(db);
  const bus = new Bus();
  const adapter: CopilotAdapter = config.fakeSdk
    ? new FakeCopilotAdapter()
    : new RealCopilotAdapter();
  const orchestrators = new OrchestratorManager({
    store,
    bus,
    adapter,
    skillHomeRoots: config.skillHomeRoots,
  });

  const app = buildApp({
    store,
    bus,
    orchestrators,
    config: { defaultModel: config.defaultModel, skillHomeRoots: config.skillHomeRoots },
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

  // WebSocket server for live event streaming.
  const wss = new WebSocketServer({ server: app.server, path: '/ws' });
  wss.on('connection', (socket: WebSocket) => {
    const unsubscribe = bus.subscribe((message) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    });
    socket.on('close', unsubscribe);
    socket.on('error', unsubscribe);
    socket.send(JSON.stringify({ type: 'hello', adapter: adapter.name }));
  });

  await app.listen({ port: config.port, host: '0.0.0.0' });
  const banner = `\n  ateam server ready\n  → http://localhost:${config.port}  (adapter: ${adapter.name})\n`;
  process.stdout.write(banner);
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
