import { openDatabase } from '../../src/server/db/database.js';
import { Store } from '../../src/server/db/store.js';
import { Bus } from '../../src/server/bus.js';
import { OrchestratorManager } from '../../src/server/orchestrator.js';
import { SchedulerService } from '../../src/server/scheduler.js';
import { GitService } from '../../src/server/git.js';
import { buildApp } from '../../src/server/app.js';
import { FakeCopilotAdapter } from '../../src/server/agents/fakeAdapter.js';
import type { ServerMessage } from '../../src/shared/index.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface TestApp {
  app: ReturnType<typeof buildApp>;
  store: Store;
  bus: Bus;
  orchestrators: OrchestratorManager;
  messages: ServerMessage[];
  /** Root under which per-epic git worktrees are created (for assertions/GC checks). */
  worktreeRoot: string;
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
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-wt-'));
  const git = new GitService(worktreeRoot);
  const orchestrators = new OrchestratorManager({
    store,
    bus,
    adapter,
    skillHomeRoots: homeRoots,
    scheduler,
    git,
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
    worktreeRoot,
    waitFor,
    close: async () => {
      await orchestrators.shutdown();
      await app.close();
      db.close();
    },
  };
}

/**
 * Remove a directory, retrying on Windows EPERM (git child processes may briefly
 * hold handles just after a merge/commit).
 */
export function rmDir(dir: string): void {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      // Busy-wait briefly, then retry.
      const until = Date.now() + 100;
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
}
