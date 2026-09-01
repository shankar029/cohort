import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateRepoDir } from '../../src/server/services.js';

const made: string[] = [];
afterEach(() => {
  for (const p of made.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});

describe('validateRepoDir', () => {
  it('accepts an existing directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-vrd-'));
    made.push(dir);
    const r = validateRepoDir(dir);
    expect(r).toMatchObject({ ok: true, resolved: path.resolve(dir) });
  });

  it('rejects a missing directory when createIfMissing is false', () => {
    const dir = path.join(os.tmpdir(), `ateam-vrd-missing-${Date.now()}`);
    const r = validateRepoDir(dir);
    expect(r).toEqual({ ok: false, error: 'Directory does not exist' });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('creates a missing directory (recursively) when createIfMissing is true', () => {
    const base = path.join(os.tmpdir(), `ateam-vrd-new-${Date.now()}`);
    made.push(base);
    const dir = path.join(base, 'nested', 'repo');
    const r = validateRepoDir(dir, true);
    expect(r).toMatchObject({ ok: true, resolved: path.resolve(dir), created: true });
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });

  it('rejects when the path exists but is a file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-vrd-'));
    made.push(dir);
    const file = path.join(dir, 'a-file');
    fs.writeFileSync(file, 'x');
    expect(validateRepoDir(file)).toEqual({ ok: false, error: 'Path is not a directory' });
    expect(validateRepoDir(file, true)).toEqual({ ok: false, error: 'Path is not a directory' });
  });
});
