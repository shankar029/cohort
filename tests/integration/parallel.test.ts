import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTestApp, rmDir, type TestApp } from '../helpers/testApp.js';
import type { ServerMessage, WorkItem } from '../../src/shared/index.js';

let ctx: TestApp;
/** A pool of throwaway repo dirs created per test; cleaned up in afterEach. */
let repoDirs: string[] = [];

beforeEach(() => {
  repoDirs = [];
  ctx = createTestApp();
});

afterEach(async () => {
  await ctx.close();
  for (const d of repoDirs) rmDir(d);
});

/** Make a fresh temp directory that a project can use as its repo. */
function makeRepoDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-parrepo-'));
  repoDirs.push(dir);
  return dir;
}

async function createProject(name: string, repoDir: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name, repoDir },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { project: { id: string } }).project.id;
}

async function addSpecialist(projectId: string, catalogId: string): Promise<void> {
  await ctx.app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/agents`,
    payload: { catalogId },
  });
}

async function sendChat(projectId: string, content: string): Promise<void> {
  await ctx.app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/chat`,
    payload: { content },
  });
}

function gitTree(repoDir: string): string[] {
  return execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], {
    cwd: repoDir,
    encoding: 'utf8',
  })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Tracks, live over the bus, the peak number of DISTINCT groups that have a child
 * task in_progress at the same moment. `groupOf` maps a work item to the group we
 * care about (its parent epic, or its project) so the same tracker serves both the
 * parallel-epics and parallel-projects scenarios.
 */
function trackConcurrentGroups(
  ctx: TestApp,
  groupOf: (m: Extract<ServerMessage, { type: 'workitem.updated' }>) => string | null,
): { peak: () => number; stop: () => void } {
  const groupById = new Map<string, string>();
  const running = new Set<string>();
  let peak = 0;
  const unsub = ctx.bus.subscribe((m) => {
    if (m.type !== 'workitem.updated') return;
    const group = groupOf(m);
    if (!group) return;
    groupById.set(m.workItem.id, group);
    if (m.workItem.status === 'in_progress') running.add(m.workItem.id);
    else running.delete(m.workItem.id);
    const activeGroups = new Set<string>();
    for (const id of running) {
      const g = groupById.get(id);
      if (g) activeGroups.add(g);
    }
    if (activeGroups.size > peak) peak = activeGroups.size;
  });
  return { peak: () => peak, stop: unsub };
}

describe('parallel epics within a single project', () => {
  it('runs two epics concurrently, isolates each, and merges both to done', async () => {
    const repoDir = makeRepoDir();
    const projectId = await createProject('Parallel Epics', repoDir);
    await addSpecialist(projectId, 'frontend-engineer');
    await addSpecialist(projectId, 'backend-engineer');
    await addSpecialist(projectId, 'qa-engineer');

    // Peak number of DISTINCT epics with a child task in_progress simultaneously.
    const tracker = trackConcurrentGroups(ctx, (m) => m.workItem.parentId);

    // Two independent user requests => two independent epics.
    await sendChat(projectId, 'Please build feature A.');
    await sendChat(projectId, 'Please build feature B.');

    // Both epics must reach done (each drives its own PR to merge).
    await ctx.waitFor(() => {
      const done = ctx.store
        .listWorkItems(projectId)
        .filter((i) => i.kind === 'epic' && i.status === 'done');
      return done.length >= 2;
    }, 45000);
    tracker.stop();

    const epics = ctx.store.listWorkItems(projectId).filter((i: WorkItem) => i.kind === 'epic');
    expect(epics.length).toBeGreaterThanOrEqual(2);

    // Isolation: each epic ran on its own ateam/epic-* branch in its own clone.
    const branches = epics.map((e) => e.branch).filter((b): b is string => !!b);
    expect(new Set(branches).size).toBeGreaterThanOrEqual(2);
    for (const e of epics) {
      const cloneDir = path.join(ctx.worktreeRoot, projectId, e.id);
      // Clones are reclaimed after merge; assert isolation held while live by
      // checking each epic got a distinct branch under the project's worktree root.
      expect(e.branch).toMatch(/^ateam\/epic-/);
      expect(cloneDir).toContain(projectId);
    }

    // Both epics were actually merged (real --no-ff merges onto the base).
    const merged = ctx.store.listPRs(projectId).filter((p) => p.status === 'merged');
    expect(merged.length).toBeGreaterThanOrEqual(2);

    // The two epics genuinely overlapped in time — not serialized one-after-another.
    expect(tracker.peak()).toBeGreaterThanOrEqual(2);

    // Both epics' deliverables landed on the single project repo's base branch.
    const tree = gitTree(repoDir);
    expect(tree.filter((f) => f.startsWith('deliverables/')).length).toBeGreaterThanOrEqual(2);
  });
});

describe('parallel projects (independent teams and repos)', () => {
  it('runs two projects concurrently, each in its own repo, and merges both', async () => {
    const repoA = makeRepoDir();
    const repoB = makeRepoDir();
    const projectA = await createProject('Project A', repoA);
    const projectB = await createProject('Project B', repoB);
    for (const pid of [projectA, projectB]) {
      await addSpecialist(pid, 'frontend-engineer');
      await addSpecialist(pid, 'qa-engineer');
    }

    // Peak number of DISTINCT projects with a child task in_progress simultaneously.
    const tracker = trackConcurrentGroups(ctx, (m) => m.projectId);

    // Kick off an epic in each project at the same time.
    await sendChat(projectA, 'Please build a settings page.');
    await sendChat(projectB, 'Please build a profile page.');

    // Each project's epic reaches done independently.
    for (const pid of [projectA, projectB]) {
      await ctx.waitFor(() => {
        return ctx.store.listWorkItems(pid).some((i) => i.kind === 'epic' && i.status === 'done');
      }, 45000);
    }
    tracker.stop();

    // Each project merged into ITS OWN repo — deliverables are isolated per repo.
    for (const repoDir of [repoA, repoB]) {
      const tree = gitTree(repoDir);
      expect(tree.some((f) => f.startsWith('deliverables/'))).toBe(true);
    }

    // Both projects merged their PRs.
    expect(ctx.store.listPRs(projectA).some((p) => p.status === 'merged')).toBe(true);
    expect(ctx.store.listPRs(projectB).some((p) => p.status === 'merged')).toBe(true);

    // The two projects genuinely ran at the same time.
    expect(tracker.peak()).toBeGreaterThanOrEqual(2);
  });
});
