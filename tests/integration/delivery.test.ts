import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTestApp, rmDir, type TestApp } from '../helpers/testApp.js';
import type { WorkItem } from '../../src/shared/index.js';

let ctx: TestApp;
let repoDir: string;

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-delrepo-'));
  ctx = createTestApp();
});

afterEach(async () => {
  await ctx.close();
  rmDir(repoDir);
});

async function createProject(name: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name, repoDir },
  });
  return (res.json() as { project: { id: string } }).project.id;
}

async function addSpecialist(
  projectId: string,
  catalogId: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await ctx.app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/agents`,
    payload: { catalogId, ...extra },
  });
}

describe('delivery correctness (worktree/cwd, empty-build gate, sequencing, GC)', () => {
  it('commits the agents’ real files to the epic branch and merges them (SEV-1)', async () => {
    const projectId = await createProject('Delivery');
    await addSpecialist(projectId, 'frontend-engineer');
    await addSpecialist(projectId, 'qa-engineer');

    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chat`,
      payload: { content: 'Please build a profile page.' },
    });

    // The epic merges once the work meets the bar.
    await ctx.waitFor((m) => m.type === 'pull_request.updated' && m.pr.status === 'merged', 15000);
    await ctx.waitFor(
      (m) =>
        m.type === 'workitem.updated' && m.workItem.kind === 'epic' && m.workItem.status === 'done',
      15000,
    );

    // The merged master tree contains REAL deliverable files the agents wrote in
    // the worktree — not just ateam's own .ateam bookkeeping.
    const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf8',
    })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const deliverables = tree.filter((f) => f.startsWith('deliverables/'));
    expect(deliverables.length).toBeGreaterThan(0);
    expect(tree.some((f) => f.startsWith('.ateam/'))).toBe(true);
  });

  it('does NOT complete a build task that produces no code — it escalates (SEV-3)', async () => {
    const projectId = await createProject('Empty Build');
    // A builder whose persona makes it narrate but never write files.
    await addSpecialist(projectId, 'backend-engineer', {
      name: 'backend',
      prompt: 'You are the Backend Engineer. [[NOOP]] You describe work but write no files.',
    });

    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chat`,
      payload: { content: 'Please build an orders API.' },
    });

    // The empty build is surfaced to the user as a question, not silently "done".
    const q = await ctx.waitFor(
      (m) => m.type === 'question.updated' && /produced no code/i.test(m.question.question),
      15000,
    );
    expect(q.type === 'question.updated' && q.question.question).toMatch(/produced no code/i);

    // The backend task never reached review/done.
    const items = ctx.store.listWorkItems(projectId);
    const backendTask = items.find((w) => w.kind === 'task' && w.stream === 'backend');
    expect(backendTask).toBeTruthy();
    expect(['review', 'done']).not.toContain(backendTask!.status);
  });

  it('sequences docs/devops to wait on the core build (SEV-3b)', async () => {
    const projectId = await createProject('Sequencing');
    await addSpecialist(projectId, 'frontend-engineer');
    await addSpecialist(projectId, 'docs-writer');

    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chat`,
      payload: { content: 'Please build a dashboard.' },
    });

    // Wait until the epic + its tasks exist.
    await ctx.waitFor(
      (m) =>
        m.type === 'workitem.updated' && m.workItem.kind === 'task' && m.workItem.stream === 'docs',
      15000,
    );
    const items = ctx.store.listWorkItems(projectId);
    const docs = items.find((w) => w.stream === 'docs') as WorkItem;
    const frontend = items.find((w) => w.stream === 'frontend') as WorkItem;
    expect(docs).toBeTruthy();
    // Docs depends on the frontend build task (does not run in parallel with it).
    expect(docs.dependsOn).toContain(frontend.id);
  });

  it('has no duplicate stream tasks under an epic (SEV-2 idempotency)', async () => {
    const projectId = await createProject('No Dupes');
    await addSpecialist(projectId, 'frontend-engineer');
    await addSpecialist(projectId, 'backend-engineer');

    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chat`,
      payload: { content: 'Please build a settings screen.' },
    });

    await ctx.waitFor(
      (m) =>
        m.type === 'workitem.updated' &&
        m.workItem.kind === 'task' &&
        m.workItem.stream === 'backend',
      15000,
    );
    const tasks = ctx.store.listWorkItems(projectId).filter((w) => w.kind === 'task');
    const streams = tasks.map((t) => t.stream);
    const unique = new Set(streams);
    expect(streams.length).toBe(unique.size); // no stream appears twice
  });

  it('reclaims the epic worktree after merge (SEV-4 GC)', async () => {
    const projectId = await createProject('GC');
    await addSpecialist(projectId, 'frontend-engineer');
    await addSpecialist(projectId, 'qa-engineer');

    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chat`,
      payload: { content: 'Please build a search box.' },
    });

    await ctx.waitFor((m) => m.type === 'pull_request.updated' && m.pr.status === 'merged', 15000);
    // Give the async post-merge cleanup a moment.
    await new Promise((r) => setTimeout(r, 300));

    const projectWtDir = path.join(ctx.worktreeRoot, projectId);
    // Either the whole project worktree dir is gone, or no epic worktree remains.
    const remaining = fs.existsSync(projectWtDir)
      ? fs.readdirSync(projectWtDir).filter((d) => d.startsWith('wi_'))
      : [];
    expect(remaining.length).toBe(0);
  });
});

describe('independent sibling tasks run concurrently (per-task clones)', () => {
  it('runs siblings in parallel and still integrates + completes the epic cleanly', async () => {
    const projectId = await createProject('Concurrent');
    // Several builder streams so decomposition yields parallel-eligible siblings.
    await addSpecialist(projectId, 'frontend-engineer');
    await addSpecialist(projectId, 'backend-engineer');
    await addSpecialist(projectId, 'ux-designer');
    await addSpecialist(projectId, 'docs-writer');
    await addSpecialist(projectId, 'qa-engineer');

    // Track how many child tasks of an epic are simultaneously in_progress.
    const inProgress = new Set<string>();
    const everRan = new Set<string>();
    let maxConcurrent = 0;
    const unsub = ctx.bus.subscribe((m) => {
      if (m.type !== 'workitem.updated' || !m.workItem.parentId) return;
      if (m.workItem.status === 'in_progress') {
        inProgress.add(m.workItem.id);
        everRan.add(m.workItem.id);
      } else {
        inProgress.delete(m.workItem.id);
      }
      if (inProgress.size > maxConcurrent) maxConcurrent = inProgress.size;
    });

    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chat`,
      payload: { content: 'Please build a profile page.' },
    });

    await ctx.waitFor(
      (m) =>
        m.type === 'workitem.updated' && m.workItem.kind === 'epic' && m.workItem.status === 'done',
      25000,
    );
    unsub();

    // Independent siblings now run at the SAME time (was serialized pre-5b), and
    // the epic still integrates every task branch and merges to done.
    expect(everRan.size).toBeGreaterThanOrEqual(2);
    expect(maxConcurrent).toBeGreaterThanOrEqual(2);
  });

  it('records per-epic parallelism metrics when the epic merges', async () => {
    const projectId = await createProject('Metrics');
    await addSpecialist(projectId, 'frontend-engineer');
    await addSpecialist(projectId, 'backend-engineer');
    await addSpecialist(projectId, 'ux-designer');

    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chat`,
      payload: { content: 'Please build a profile page.' },
    });
    const done = await ctx.waitFor(
      (m) =>
        m.type === 'workitem.updated' && m.workItem.kind === 'epic' && m.workItem.status === 'done',
      25000,
    );
    const epicId = done.type === 'workitem.updated' ? done.workItem.id : '';

    const res = await ctx.app.inject({ method: 'GET', url: `/api/workitems/${epicId}/metrics` });
    expect(res.statusCode).toBe(200);
    const { metrics } = res.json() as {
      metrics: {
        taskCount: number;
        builderCount: number;
        independentBuilders: number;
        maxConcurrent: number;
      } | null;
    };
    expect(metrics).toBeTruthy();
    // Three independent builder streams should have run in parallel.
    expect(metrics!.independentBuilders).toBeGreaterThanOrEqual(2);
    expect(metrics!.maxConcurrent).toBeGreaterThanOrEqual(2);
    expect(metrics!.builderCount).toBeGreaterThanOrEqual(3);

    // The project-level aggregate lists it too.
    const agg = await ctx.app.inject({ method: 'GET', url: `/api/projects/${projectId}/metrics` });
    const { metrics: all } = agg.json() as { metrics: Array<{ epicId: string }> };
    expect(all.some((m) => m.epicId === epicId)).toBe(true);
  });
});

describe('QA sign-off is gated on the project test command actually passing', () => {
  it('lets QA sign off and the epic merge when the test command passes', async () => {
    const projectId = await createProject('QAGatePass');
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}`,
      payload: { testCommand: 'node -e "process.exit(0)"' },
    });
    await addSpecialist(projectId, 'frontend-engineer');
    await addSpecialist(projectId, 'qa-engineer');
    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chat`,
      payload: { content: 'Please build a profile page.' },
    });

    // QA must have actually RUN the command and seen it pass.
    await ctx.waitFor(
      (m) => m.type === 'event.appended' && /QA gate: .* passed/.test(m.event.summary),
      20000,
    );
    // And the normal pipeline still completes.
    await ctx.waitFor((m) => m.type === 'pull_request.updated' && m.pr.status === 'merged', 20000);
  });

  it('blocks QA sign-off (no merge) when the test command fails', async () => {
    const projectId = await createProject('QAGateFail');
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}`,
      payload: { testCommand: 'node -e "process.exit(1)"' },
    });
    await addSpecialist(projectId, 'frontend-engineer');
    await addSpecialist(projectId, 'qa-engineer');

    let merged = false;
    const unsub = ctx.bus.subscribe((m) => {
      if (m.type === 'pull_request.updated' && m.pr.status === 'merged') merged = true;
    });

    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chat`,
      payload: { content: 'Please build a profile page.' },
    });

    // The failing suite blocks sign-off — surfaced explicitly.
    await ctx.waitFor(
      (m) => m.type === 'event.appended' && /QA gate FAILED/.test(m.event.summary),
      20000,
    );
    unsub();
    // The epic must NOT have merged on the back of a failing QA gate.
    expect(merged).toBe(false);
    const epic = (await ctx.app
      .inject({ method: 'GET', url: `/api/projects/${projectId}/workitems` })
      .then((r) => r.json())) as { workItems: WorkItem[] };
    expect(epic.workItems.find((w) => w.kind === 'epic')?.status).not.toBe('done');
  });
});

describe('deterministic constraint gate (FAITH-1)', () => {
  it('blocks a task that violates a hard constraint (external dependency)', async () => {
    const projectId = await createProject('Constraint');
    // A backend builder that ships an external dependency (express) despite the
    // request's explicit dependency-free requirement.
    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/agents`,
      payload: {
        name: 'backend',
        displayName: 'Backend Engineer',
        prompt:
          'You build the service. ' +
          "[[EMIT_FILE: src/app.js | const express = require('express');\\nconst app = express();\\nmodule.exports = app;]]",
      },
    });

    let merged = false;
    const unsub = ctx.bus.subscribe((m) => {
      if (m.type === 'pull_request.updated' && m.pr.status === 'merged') merged = true;
    });

    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chat`,
      payload: {
        content:
          "Build an in-memory URL shortener using ONLY Node's built-in http module - " +
          'no external dependencies. This is a headless API, there is no UI.',
      },
    });

    // The deterministic scan catches the express import BEFORE review.
    const ev = await ctx.waitFor(
      (m) => m.type === 'event.appended' && /Constraint gate FAILED/.test(m.event.summary),
      20000,
    );
    expect(ev.type === 'event.appended' && ev.event.summary).toMatch(/no-external-deps/);
    unsub();
    expect(merged).toBe(false);
  });
});

describe('brownfield epics converge on a single concrete build task', () => {
  it('creates ONE primary build task (not a per-stream fan-out) on an existing codebase', async () => {
    // Seed the repo with substantial existing source so it reads as brownfield.
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(
        path.join(repoDir, 'src', `mod${i}.ts`),
        `export const v${i} = ${i};\nexport function f${i}() {\n  return v${i};\n}\n`,
      );
    }

    const projectId = await createProject('Brownfield');
    // A multi-stream team that WOULD normally fan out one task per stream.
    await addSpecialist(projectId, 'frontend-engineer');
    await addSpecialist(projectId, 'backend-engineer');
    await addSpecialist(projectId, 'ux-designer');
    await addSpecialist(projectId, 'qa-engineer');

    await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/chat`,
      payload: { content: 'Please add a small improvement to this codebase.' },
    });

    // Fake mode is exempt from the docs-only gate, so the epic still merges.
    await ctx.waitFor((m) => m.type === 'pull_request.updated' && m.pr.status === 'merged', 20000);

    const { workItems } = (await ctx.app
      .inject({ method: 'GET', url: `/api/projects/${projectId}/workitems` })
      .then((r) => r.json())) as { workItems: WorkItem[] };
    const epic = workItems.find((w) => w.kind === 'epic');
    expect(epic).toBeTruthy();
    const isVerifier = (s: string | null | undefined) => /^(qa|reviewer|security)$/.test(s ?? '');
    const buildTasks = workItems.filter(
      (w) => w.kind === 'task' && w.parentId === epic!.id && !isVerifier(w.stream),
    );
    // Exactly one concrete build task, assigned to the primary builder (backend).
    expect(buildTasks.length).toBe(1);
    expect(buildTasks[0]!.stream).toBe('backend');
  });
});
