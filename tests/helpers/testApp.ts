import { openDatabase } from '../../src/server/db/database.js';
import { Store } from '../../src/server/db/store.js';
import { Bus } from '../../src/server/bus.js';
import { OrchestratorManager } from '../../src/server/orchestrator.js';
import { SchedulerService } from '../../src/server/scheduler.js';
import { buildApp } from '../../src/server/app.js';
import { FakeCopilotAdapter } from '../../src/server/agents/fakeAdapter.js';
import type { ServerMessage } from '../../src/shared/index.js';

export interface TestApp {
  app: ReturnType<typeof buildApp>;
  store: Store;
  bus: Bus;
  orchestrators: OrchestratorManager;
  messages: ServerMessage[];
  /** Resolve once a bus message matching the predicate is published. */
  waitFor: (predicate: (m: ServerMessage) => boolean, timeoutMs?: number) => Promise<ServerMessage>;
  close: () => Promise<void>;
}

export function createTestApp(homeRoots: string[] = []): TestApp {
  const db = openDatabase(':memory:');
  const store = new Store(db);
  const bus = new Bus();
  const adapter = new FakeCopilotAdapter();
  const scheduler = new SchedulerService();
  const orchestrators = new OrchestratorManager({
    store,
    bus,
    adapter,
    skillHomeRoots: homeRoots,
    scheduler,
  });
  const app = buildApp({
    store,
    bus,
    orchestrators,
    config: { defaultModel: 'test-model', skillHomeRoots: homeRoots },
    listModels: () => adapter.listModels(),
  });

  const messages: ServerMessage[] = [];
  const waiters = new Set<(m: ServerMessage) => void>();
  bus.subscribe((m) => {
    messages.push(m);
    for (const w of [...waiters]) w(m);
  });

  const waitFor = (
    predicate: (m: ServerMessage) => boolean,
    timeoutMs = 5000,
  ): Promise<ServerMessage> => {
    const found = messages.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(handler);
        reject(new Error('waitFor timed out'));
      }, timeoutMs);
      const handler = (m: ServerMessage): void => {
        if (predicate(m)) {
          clearTimeout(timer);
          waiters.delete(handler);
          resolve(m);
        }
      };
      waiters.add(handler);
    });
  };

  return {
    app,
    store,
    bus,
    orchestrators,
    messages,
    waitFor,
    close: async () => {
      await orchestrators.shutdown();
      await app.close();
      db.close();
    },
  };
}
