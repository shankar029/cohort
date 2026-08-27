import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveTestCommand,
  runProjectTests,
  resolveBuildCommand,
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
