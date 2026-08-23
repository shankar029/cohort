import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listDirs } from '../../src/server/app.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-fs-'));
  fs.mkdirSync(path.join(root, 'alpha'));
  fs.mkdirSync(path.join(root, 'beta'));
  fs.mkdirSync(path.join(root, '.hidden'));
  fs.writeFileSync(path.join(root, 'file.txt'), 'x');
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('listDirs', () => {
  it('returns only sub-directories, sorted, skipping dotfiles and files', () => {
    const r = listDirs(root);
    expect(r.path).toBe(path.resolve(root));
    expect(r.entries.map((e) => e.name)).toEqual(['alpha', 'beta']);
    expect(r.entries[0]!.path).toBe(path.join(path.resolve(root), 'alpha'));
  });

  it('reports a parent for a normal directory', () => {
    const r = listDirs(root);
    expect(r.parent).toBe(path.dirname(path.resolve(root)));
  });

  it('lists roots (home + drives/home) when no path is given', () => {
    const r = listDirs();
    expect(r.path).toBeNull();
    expect(r.parent).toBeNull();
    expect(r.entries.length).toBeGreaterThan(0);
    expect(r.entries.some((e) => e.name.startsWith('~'))).toBe(true);
  });

  it('throws for a non-existent path', () => {
    expect(() => listDirs(path.join(root, 'does-not-exist'))).toThrow();
  });

  it('throws when the path is a file, not a directory', () => {
    expect(() => listDirs(path.join(root, 'file.txt'))).toThrow();
  });
});
