import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestApp, rmDir, type TestApp } from '../helpers/testApp.js';
import type { AgentEvent } from '../../src/shared/index.js';

let ctx: TestApp;
const repos: string[] = [];

beforeEach(() => {
  ctx = createTestApp();
});

afterEach(async () => {
  await ctx.close();
  while (repos.length) rmDir(repos.pop()!);
});

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-evtrepo-'));
  repos.push(dir);
  return dir;
}

async function createProject(name: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name, repoDir: makeRepo() },
  });
  return (res.json() as { project: { id: string } }).project.id;
}

async function fetchEvents(projectId: string, query = ''): Promise<AgentEvent[]> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/projects/${projectId}/events${query}`,
  });
  if (res.statusCode !== 200) throw new Error(`events ${res.statusCode}: ${res.body}`);
  return (res.json() as { events: AgentEvent[] }).events;
}

describe('events paging (BUG-2): newest-first window, chronological display, ?limit=', () => {
  it('keeps the NEWEST events (not the oldest) once past the cap and respects ?limit=', async () => {
    const projectId = await createProject('Paging');

    // Append well past the default 500-row window. Timestamps are far in the future
    // so these are unambiguously the NEWEST events (createProject also emits a few
    // setup events dated at real `now()`); we assert on our own `event-*` rows.
    const total = 650;
    const base = Date.now() + 3600_000;
    for (let i = 0; i < total; i += 1) {
      ctx.store.appendEvent({
        projectId,
        agentId: null,
        type: 'system',
        summary: `event-${i}`,
        createdAt: new Date(base + i * 1000).toISOString(),
      });
    }
    const mineOf = (evs: AgentEvent[]): AgentEvent[] =>
      evs.filter((e) => /^event-\d+$/.test(e.summary));

    // Default window = newest 500, returned oldest→newest for display. Since our
    // rows are the newest in the project, the whole window is ours.
    const def = await fetchEvents(projectId);
    const defMine = mineOf(def);
    expect(def.length).toBe(500);
    expect(defMine.length).toBe(500);
    expect(defMine[0]!.summary).toBe(`event-${total - 500}`); // event-150 (oldest kept)
    expect(defMine[defMine.length - 1]!.summary).toBe(`event-${total - 1}`); // event-649 (newest)
    // Ascending by time.
    for (let i = 1; i < defMine.length; i += 1) {
      expect(defMine[i]!.createdAt >= defMine[i - 1]!.createdAt).toBe(true);
    }

    // Explicit small limit still returns the newest N chronologically.
    const small = mineOf(await fetchEvents(projectId, '?limit=10'));
    expect(small.length).toBe(10);
    expect(small[0]!.summary).toBe(`event-${total - 10}`); // event-640
    expect(small[small.length - 1]!.summary).toBe(`event-${total - 1}`); // event-649

    // Over-max limit is clamped (not rejected); still returns all of our rows.
    const big = mineOf(await fetchEvents(projectId, '?limit=999999'));
    expect(big.length).toBe(total);
    expect(big[0]!.summary).toBe('event-0');
    expect(big[big.length - 1]!.summary).toBe(`event-${total - 1}`);
  });
});
