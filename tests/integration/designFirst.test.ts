import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTestApp, rmDir, type TestApp } from '../helpers/testApp.js';

let ctx: TestApp;
let repoDir: string;

function gitRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-df-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@e',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@e',
  };
  execFileSync('git', ['init', '-q'], { cwd: dir, env });
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  execFileSync('git', ['add', '.'], { cwd: dir, env });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir, env });
  return dir;
}

/** A brownfield fixture: >=8 tracked source files so isBrownfieldRepo() is true. */
function brownfieldRepo(): string {
  const files: Record<string, string> = { 'README.md': '# App\n', 'AGENTS.md': '# Use TypeScript + Fastify.\n' };
  for (let i = 0; i < 10; i++) files[`src/mod${i}.ts`] = `export const v${i} = ${i};\n`;
  return gitRepo(files);
}

beforeEach(() => {
  ctx = createTestApp();
});

afterEach(async () => {
  await ctx.close();
  if (repoDir) rmDir(repoDir);
});

async function createProject(name: string): Promise<string> {
  const res = await ctx.app.inject({ method: 'POST', url: '/api/projects', payload: { name, repoDir } });
  expect(res.statusCode).toBe(201);
  return (res.json() as { project: { id: string } }).project.id;
}

async function addAgent(projectId: string, catalogId: string, prompt?: string): Promise<void> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/agents`,
    payload: { catalogId, ...(prompt ? { prompt } : {}) },
  });
  expect(res.statusCode).toBeLessThan(300);
}

async function chat(projectId: string, content: string): Promise<void> {
  const res = await ctx.app.inject({ method: 'POST', url: `/api/projects/${projectId}/chat`, payload: { content } });
  expect(res.statusCode).toBeLessThan(300);
}

function childTasks(projectId: string) {
  const epics = ctx.store.listWorkItems(projectId).filter((w) => w.kind === 'epic');
  return epics.flatMap((e) => ctx.store.listChildTasks(e.id));
}

describe('design-first decomposition (AC1)', () => {
  it('a non-trivial epic runs the Architect design turn and ENRICHES the tasks before builders act', async () => {
    repoDir = brownfieldRepo();
    const projectId = await createProject('DF Standard');
    await addAgent(projectId, 'architect');
    await addAgent(projectId, 'backend-engineer');
    await addAgent(projectId, 'frontend-engineer');

    await chat(projectId, 'Build a complete orders feature with an API and a settings dashboard.');

    // The design is persisted and at least one task is enriched with design acceptance.
    const enriched = await ctx.waitFor(
      (m) =>
        m.type === 'workitem.updated' &&
        (m.workItem.description ?? '').includes('<!--design-acceptance-->'),
      15000,
    );
    expect(enriched.type === 'workitem.updated' && enriched.workItem.description).toContain(
      'Design acceptance',
    );

    const epic = ctx.store.listWorkItems(projectId).find((w) => w.kind === 'epic')!;
    expect(ctx.store.getEpicDesign(epic.id)).not.toBe('');
    // The board floor exists (tasks were created synchronously, never stranded).
    expect(childTasks(projectId).length).toBeGreaterThan(0);
  });

  it('with NO architect on the team, the Lead runs the design turn and still enriches (AC3 fallback)', async () => {
    repoDir = brownfieldRepo();
    const projectId = await createProject('DF Lead');
    await addAgent(projectId, 'backend-engineer');
    await addAgent(projectId, 'frontend-engineer');

    await chat(projectId, 'Build a complete billing feature with an API and a settings dashboard.');

    const enriched = await ctx.waitFor(
      (m) =>
        m.type === 'workitem.updated' &&
        (m.workItem.description ?? '').includes('<!--design-acceptance-->'),
      15000,
    );
    expect(enriched.type).toBe('workitem.updated');
    const epic = ctx.store.listWorkItems(projectId).find((w) => w.kind === 'epic')!;
    expect(ctx.store.getEpicDesign(epic.id)).not.toBe('');
  });
});

describe('complexity gate (AC2)', () => {
  it('a trivial change skips the design step: no design persisted, tasks still created', async () => {
    repoDir = brownfieldRepo();
    const projectId = await createProject('DF Trivial');
    await addAgent(projectId, 'architect');
    await addAgent(projectId, 'backend-engineer');

    await chat(projectId, 'fix a typo in the README');

    // Tasks are created (board never stranded) …
    await ctx.waitFor((m) => m.type === 'workitem.updated' && m.workItem.kind === 'task', 15000);
    // … and give the (skipped) design turn a moment; it must NOT have run.
    await new Promise((r) => setTimeout(r, 500));
    const epic = ctx.store.listWorkItems(projectId).find((w) => w.kind === 'epic')!;
    expect(ctx.store.getEpicDesign(epic.id)).toBe('');
    expect(childTasks(projectId).every((t) => !(t.description ?? '').includes('design-acceptance'))).toBe(
      true,
    );
  });
});

describe('never strand the board (AC3)', () => {
  it('when the design turn times out, tasks keep their template descriptions and the board is non-empty', async () => {
    const prev = process.env.ATEAM_DESIGN_TIMEOUT_MS;
    process.env.ATEAM_DESIGN_TIMEOUT_MS = '1'; // force the timeout/no-op path
    try {
      repoDir = brownfieldRepo();
      const projectId = await createProject('DF Timeout');
      await addAgent(projectId, 'architect');
      await addAgent(projectId, 'backend-engineer');
      await addAgent(projectId, 'frontend-engineer');

      await chat(projectId, 'Build a complete orders feature with an API and a settings dashboard.');

      // A task appears (the synchronous template floor) …
      await ctx.waitFor((m) => m.type === 'workitem.updated' && m.workItem.kind === 'task', 15000);
      await new Promise((r) => setTimeout(r, 300));
      const tasks = childTasks(projectId);
      expect(tasks.length).toBeGreaterThan(0);
      // … and none was enriched, because the design turn was abandoned at 1ms.
      expect(tasks.every((t) => !(t.description ?? '').includes('design-acceptance'))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.ATEAM_DESIGN_TIMEOUT_MS;
      else process.env.ATEAM_DESIGN_TIMEOUT_MS = prev;
    }
  });
});
