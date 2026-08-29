import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectConstraints,
  checkClone,
  summarizeViolations,
} from '../../src/server/constraints.js';

describe('deterministic delivery constraints', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-constraints-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const write = (rel: string, body: string): void => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  };

  describe('detectConstraints', () => {
    it('extracts the hard constraints from a headless dependency-free request', () => {
      const kinds = detectConstraints([
        "Build an in-memory URL shortener using ONLY Node's built-in http module - " +
          'no external dependencies. This is a headless API, there is no UI.',
      ]).map((c) => c.kind);
      expect(kinds).toContain('no-external-deps');
      expect(kinds).toContain('in-memory');
      expect(kinds).toContain('no-ui');
    });

    it('returns nothing when no hard constraint is stated', () => {
      expect(detectConstraints(['Build a nice task tracker web app with a database.'])).toEqual([]);
    });
  });

  describe('checkClone', () => {
    it('flags an external runtime dependency (express) on a dependency-free task', () => {
      write('package.json', JSON.stringify({ dependencies: { express: '^4' } }));
      write('src/app.js', "const express = require('express');\nconst app = express();\n");
      const cons = detectConstraints(['only built-in modules, no external dependencies']);
      const v = checkClone(dir, cons);
      expect(v).toHaveLength(1);
      expect(v[0]!.kind).toBe('no-external-deps');
      expect(v[0]!.detail).toMatch(/express/);
      expect(v[0]!.files).toContain(path.join('src', 'app.js'));
    });

    it('flags a bare import even when it is not in the manifest', () => {
      write('src/server.js', "import fastify from 'fastify';\nexport const app = fastify();\n");
      const v = checkClone(dir, detectConstraints(['no external dependencies']));
      expect(v.map((x) => x.kind)).toContain('no-external-deps');
      expect(v[0]!.detail).toMatch(/fastify/);
    });

    it('does NOT flag node builtins or relative imports', () => {
      write(
        'src/server.js',
        "import http from 'node:http';\nimport { helper } from './util.js';\n",
      );
      write('src/util.js', 'export const helper = () => 1;\n');
      write('src/crypto.js', "const crypto = require('crypto');\nmodule.exports = crypto;\n");
      expect(checkClone(dir, detectConstraints(['no external dependencies']))).toEqual([]);
    });

    it('ignores dev tooling imported only from test files', () => {
      write('src/server.js', "import http from 'node:http';\nexport const s = http;\n");
      write(
        'test/server.test.js',
        "import { describe } from 'vitest';\nimport request from 'supertest';\n",
      );
      expect(checkClone(dir, detectConstraints(['no external dependencies']))).toEqual([]);
    });

    it('flags disk persistence on an in-memory task', () => {
      write(
        'src/store.js',
        "const fs = require('fs');\nfs.writeFileSync('data/links.json', '{}');\n",
      );
      const v = checkClone(dir, detectConstraints(['state is in-memory, lost on restart']));
      expect(v.map((x) => x.kind)).toContain('in-memory');
      expect(v.find((x) => x.kind === 'in-memory')!.files).toContain(path.join('src', 'store.js'));
    });

    it('flags a database library on an in-memory task', () => {
      write('package.json', JSON.stringify({ dependencies: { 'better-sqlite3': '^9' } }));
      write('src/db.js', "const Database = require('better-sqlite3');\n");
      const v = checkClone(dir, detectConstraints(['no database - keep state in memory']));
      expect(v.map((x) => x.kind)).toContain('in-memory');
      expect(v.find((x) => x.kind === 'in-memory')!.files).toContain(path.join('src', 'db.js'));
    });

    it('flags UI files on a headless task', () => {
      write('src/App.tsx', 'export default function App() { return null; }\n');
      const v = checkClone(dir, detectConstraints(['headless API, no UI']));
      expect(v.map((x) => x.kind)).toContain('no-ui');
      expect(v.find((x) => x.kind === 'no-ui')!.files).toContain(path.join('src', 'App.tsx'));
    });

    it('is a clean pass for a faithful in-memory, dependency-free, headless service', () => {
      write('package.json', JSON.stringify({ name: 'svc', devDependencies: { vitest: '^2' } }));
      write(
        'src/server.js',
        "import http from 'node:http';\nconst store = new Map();\nexport const s = http.createServer();\n",
      );
      write(
        'src/client.js',
        "import http from 'node:http';\nexport const get = () => http.request;\n",
      );
      const cons = detectConstraints([
        "in-memory URL shortener, only Node's built-in http, no external dependencies, headless",
      ]);
      expect(checkClone(dir, cons)).toEqual([]);
    });

    it('summarizes violations for logs', () => {
      write('package.json', JSON.stringify({ dependencies: { express: '^4' } }));
      write('src/app.js', "const express = require('express');\n");
      const s = summarizeViolations(
        checkClone(dir, detectConstraints(['no external dependencies'])),
      );
      expect(s).toMatch(/no-external-deps/);
      expect(s).toMatch(/express/);
    });

    it('does nothing when there are no constraints', () => {
      write('package.json', JSON.stringify({ dependencies: { express: '^4' } }));
      expect(checkClone(dir, [])).toEqual([]);
    });
  });
});
