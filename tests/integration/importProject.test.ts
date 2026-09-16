import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { cloneRepoToDir } from '../../src/server/clone.js';
import { createTestApp, rmDir, type TestApp } from '../helpers/testApp.js';

const made: string[] = [];
let ctx: TestApp | null = null;

afterEach(async () => {
  if (ctx) {
    await ctx.close();
    ctx = null;
  }
  for (const p of made.splice(0)) rmDir(p);
});

/** Create a real local git repo with one commit; returns its absolute path. */
function makeFixtureRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-src-'));
  made.push(dir);
  const run = (args: string[]): void => {
    execFileSync('git', args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@e',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@e',
      },
    });
  };
  run(['init', '-q']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'init']);
  return dir;
}

describe('cloneRepoToDir', () => {
  it('clones a local fixture repo into <parent>/<name>', async () => {
    const src = makeFixtureRepo();
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-parent-'));
    made.push(parent);
    const res = await cloneRepoToDir(pathToFileURL(src).href, parent, 'cloned');
    expect(res.ok).toBe(true);
    expect(res.path).toBe(path.join(parent, 'cloned'));
    expect(fs.existsSync(path.join(parent, 'cloned', '.git'))).toBe(true);
    expect(fs.existsSync(path.join(parent, 'cloned', 'README.md'))).toBe(true);
  });

  it('fails fast and leaves no partial dir when the source does not exist', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-parent-'));
    made.push(parent);
    const bogus = pathToFileURL(path.join(os.tmpdir(), `nope-${Date.now()}`)).href;
    const started = Date.now();
    const res = await cloneRepoToDir(bogus, parent, 'x');
    expect(res.ok).toBe(false);
    expect(res.stderr.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(parent, 'x'))).toBe(false); // partial cleaned up
    expect(Date.now() - started).toBeLessThan(15000); // no hang
  });
});

describe('POST /api/projects import (route)', () => {
  it('imports a project from a git URL and provisions the Team Lead (AC2)', async () => {
    const src = makeFixtureRepo();
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-parent-'));
    made.push(parent);
    ctx = createTestApp();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { source: 'import', repoUrl: pathToFileURL(src).href, parentDir: parent },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { project: { id: string; name: string; repoDir: string }; agents: unknown[] };
    // Name derived from the source dir; repoDir is the cloned checkout under parent.
    expect(body.project.repoDir.startsWith(path.resolve(parent))).toBe(true);
    expect(fs.existsSync(path.join(body.project.repoDir, '.git'))).toBe(true);
    expect(body.agents.length).toBeGreaterThanOrEqual(1); // Team Lead provisioned
    expect(ctx.store.listProjects()).toHaveLength(1);
  });

  it('rejects a malformed URL with 400 before any git call (AC2.1)', async () => {
    ctx = createTestApp();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { source: 'import', repoUrl: 'not-a-git-url', parentDir: os.tmpdir() },
    });
    expect(res.statusCode).toBe(400);
    expect(ctx.store.listProjects()).toHaveLength(0);
  });

  it('surfaces a clone failure as 400 with no project row and no hang (AC2.2)', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-parent-'));
    made.push(parent);
    ctx = createTestApp();
    const bogus = pathToFileURL(path.join(os.tmpdir(), `missing-${Date.now()}`)).href;
    const started = Date.now();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { source: 'import', repoUrl: bogus, parentDir: parent },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/clone failed/i);
    expect(ctx.store.listProjects()).toHaveLength(0);
    expect(Date.now() - started).toBeLessThan(15000);
  });

  it('rejects when the target folder already exists (no clobber)', async () => {
    const src = makeFixtureRepo();
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-parent-'));
    made.push(parent);
    const name = path.basename(src); // deriveRepoName of file url = last segment = src basename
    fs.mkdirSync(path.join(parent, name));
    ctx = createTestApp();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { source: 'import', repoUrl: pathToFileURL(src).href, parentDir: parent },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/already exists/i);
    expect(ctx.store.listProjects()).toHaveLength(0);
  });

  it('still creates a local project when source is omitted (AC1 regression)', async () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-local-'));
    made.push(repoDir);
    ctx = createTestApp();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Local One', repoDir },
    });
    expect(res.statusCode).toBe(201);
    expect(ctx.store.listProjects()).toHaveLength(1);
  });
});
