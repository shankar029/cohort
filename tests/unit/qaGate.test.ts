import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveTestCommand,
  runProjectTests,
  resolveBuildCommand,
  resolveAcceptanceProbe,
  runAcceptanceProbe,
  ensureDependencies,
} from '../../src/server/qaGate.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-qagate-'));
});
afterEach(() => {
  // A timed-out child may briefly hold the dir on Windows; cleanup is best-effort.
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* leaked temp dir; harmless in tests */
  }
});

function writePkg(scripts: Record<string, string>): void {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts }));
}

describe('resolveTestCommand', () => {
  it('prefers an explicit override over everything', () => {
    writePkg({ test: 'vitest' });
    expect(resolveTestCommand(dir, 'pytest -q')).toBe('pytest -q');
  });

  it('returns null when there is no package.json and no override', () => {
    expect(resolveTestCommand(dir)).toBeNull();
  });

  it('detects scripts in priority order test:e2e > e2e > test', () => {
    writePkg({ test: 'vitest', e2e: 'playwright test', 'test:e2e': 'cypress run' });
    expect(resolveTestCommand(dir)).toBe('npm run test:e2e --silent');
    writePkg({ test: 'vitest', e2e: 'playwright test' });
    expect(resolveTestCommand(dir)).toBe('npm run e2e --silent');
    writePkg({ test: 'vitest' });
    expect(resolveTestCommand(dir)).toBe('npm run test --silent');
  });

  it('ignores the npm "no test specified" placeholder', () => {
    writePkg({ test: 'echo "Error: no test specified" && exit 1' });
    expect(resolveTestCommand(dir)).toBeNull();
  });

  it('tolerates an invalid package.json', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{ not json');
    expect(resolveTestCommand(dir)).toBeNull();
  });
});

describe('resolveBuildCommand', () => {
  it('prefers an explicit override', () => {
    writePkg({ build: 'vite build' });
    expect(resolveBuildCommand(dir, 'tsc --noEmit')).toBe('tsc --noEmit');
  });

  it('detects scripts in priority order typecheck > build > compile', () => {
    writePkg({ compile: 'tsc', build: 'vite build', typecheck: 'tsc --noEmit' });
    expect(resolveBuildCommand(dir)).toBe('npm run typecheck --silent');
    writePkg({ compile: 'tsc', build: 'vite build' });
    expect(resolveBuildCommand(dir)).toBe('npm run build --silent');
    writePkg({ compile: 'tsc' });
    expect(resolveBuildCommand(dir)).toBe('npm run compile --silent');
  });

  it('returns null when there is no build script (graceful no-op)', () => {
    writePkg({ test: 'vitest' });
    expect(resolveBuildCommand(dir)).toBeNull();
    expect(resolveBuildCommand(dir)).toBeNull();
  });
});

describe('runProjectTests', () => {
  it('reports ran:false when nothing is runnable', async () => {
    const r = await runProjectTests(dir);
    expect(r.ran).toBe(false);
    expect(r.passed).toBe(false);
    expect(r.command).toBe('');
  });

  it('passes when the command exits 0', async () => {
    const r = await runProjectTests(dir, `"${process.execPath}" -e "process.exit(0)"`);
    expect(r.ran).toBe(true);
    expect(r.passed).toBe(true);
  });

  it('fails when the command exits non-zero', async () => {
    const r = await runProjectTests(
      dir,
      `"${process.execPath}" -e "console.error('boom');process.exit(1)"`,
    );
    expect(r.ran).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.output).toContain('boom');
  });

  it('treats a timeout as a failure without hanging', async () => {
    const r = await runProjectTests(
      dir,
      `"${process.execPath}" -e "setTimeout(()=>{}, 10000)"`,
      300,
    );
    expect(r.ran).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.output).toContain('[timed out]');
  });

  it('runs the suite with CI=1 (deterministic, non-interactive)', async () => {
    const r = await runProjectTests(
      dir,
      `"${process.execPath}" -e "process.exit(process.env.CI ? 0 : 1)"`,
    );
    expect(r.ran).toBe(true);
    expect(r.passed).toBe(true);
  });

  it('does not inherit stdin, so a suite that reads input cannot hang', async () => {
    // stdin is 'ignore', so reading it hits EOF immediately instead of blocking.
    const r = await runProjectTests(
      dir,
      `"${process.execPath}" -e "process.stdin.on('end',()=>process.exit(0));process.stdin.resume()"`,
      3000,
    );
    expect(r.ran).toBe(true);
    expect(r.passed).toBe(true);
    expect(r.output).not.toContain('[timed out]');
  });
});

describe('ensureDependencies (I3)', () => {
  it('is a no-op when there is no package.json', async () => {
    const r = await ensureDependencies(dir);
    expect(r.ran).toBe(false);
    expect(r.passed).toBe(true);
  });

  it('is a no-op when package.json declares no dependencies', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: {} }));
    const r = await ensureDependencies(dir);
    expect(r.ran).toBe(false);
    expect(r.passed).toBe(true);
  });

  it('is a no-op when node_modules already exists', async () => {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'x', dependencies: { left_pad: '1.0.0' } }),
    );
    fs.mkdirSync(path.join(dir, 'node_modules'));
    const r = await ensureDependencies(dir);
    expect(r.ran).toBe(false);
    expect(r.passed).toBe(true);
    expect(r.output).toContain('node_modules present');
  });
});

describe('resolveAcceptanceProbe (MAJOR-1)', () => {
  it('prefers an explicit acceptanceCommand override over everything', () => {
    fs.mkdirSync(path.join(dir, '.ateam'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.ateam', 'acceptance.mjs'), 'process.exit(0)');
    expect(resolveAcceptanceProbe(dir, 'node probe.js')).toBe('node probe.js');
  });

  it('resolves a committed .ateam/acceptance.mjs probe when no override is set', () => {
    fs.mkdirSync(path.join(dir, '.ateam'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.ateam', 'acceptance.mjs'), 'process.exit(0)');
    expect(resolveAcceptanceProbe(dir)).toBe('node .ateam/acceptance.mjs');
  });

  it('returns null (graceful skip) when neither an override nor a probe file exists', () => {
    expect(resolveAcceptanceProbe(dir)).toBeNull();
  });
});

describe('runAcceptanceProbe (MAJOR-1)', () => {
  it('reports pass when the probe exits 0', async () => {
    fs.mkdirSync(path.join(dir, '.ateam'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.ateam', 'acceptance.mjs'),
      'console.log("ok"); process.exit(0);',
    );
    const r = await runAcceptanceProbe(dir);
    expect(r.ran).toBe(true);
    expect(r.passed).toBe(true);
  });

  it('reports fail when the probe exits non-zero (contract not met)', async () => {
    fs.mkdirSync(path.join(dir, '.ateam'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.ateam', 'acceptance.mjs'),
      'console.error("AC1 FAILED: missing endpoint"); process.exit(1);',
    );
    const r = await runAcceptanceProbe(dir);
    expect(r.ran).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.output).toMatch(/AC1 FAILED/);
  });

  it('is a graceful no-op (ran:false => skip) when there is no probe', async () => {
    const r = await runAcceptanceProbe(dir);
    expect(r.ran).toBe(false);
  });

  it('runs an explicit override command in the directory', async () => {
    const r = await runAcceptanceProbe(dir, 'node -e "process.exit(0)"');
    expect(r.ran).toBe(true);
    expect(r.passed).toBe(true);
  });
});
