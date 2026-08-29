import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestApp, rmDir, type TestApp } from '../helpers/testApp.js';

let ctx: TestApp;
let repoDir: string;

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-uprepo-'));
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

describe('chat file uploads (B2)', () => {
  it('stores a base64 upload under .ateam/uploads and returns a repo-relative path', async () => {
    const projectId = await createProject('Uploads');
    const dataBase64 = Buffer.from('hello attachment').toString('base64');
    const up = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/uploads`,
      payload: { name: 'notes.txt', dataBase64 },
    });
    expect(up.statusCode).toBe(201);
    const out = up.json() as { path: string; name: string; bytes: number };
    expect(out.path).toMatch(/^\.ateam\/uploads\/\d+-notes\.txt$/);
    expect(out.bytes).toBe(16);
    const abs = path.join(repoDir, out.path);
    expect(fs.existsSync(abs)).toBe(true);
    expect(fs.readFileSync(abs, 'utf8')).toBe('hello attachment');
  });

  it('never escapes the uploads directory even with a traversal-style filename', async () => {
    const projectId = await createProject('Uploads2');
    const up = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/uploads`,
      payload: { name: '../../evil /passwd', dataBase64: Buffer.from('x').toString('base64') },
    });
    const out = up.json() as { path: string };
    const base = path.resolve(repoDir, '.ateam', 'uploads');
    expect(path.resolve(repoDir, out.path).startsWith(base)).toBe(true);
    // The written file is a single sanitized name directly under uploads/.
    expect(path.dirname(path.resolve(repoDir, out.path))).toBe(base);
  });
});
