import os from 'node:os';
import path from 'node:path';

/** Resolved runtime configuration, from env with sane defaults. */
export interface Config {
  port: number;
  dbPath: string;
  defaultModel: string;
  fakeSdk: boolean;
  /** Home roots scanned for skills, in addition to per-project extras. */
  skillHomeRoots: string[];
  isProduction: boolean;
  webDistDir: string;
  /** Base directory for per-epic git worktrees. */
  worktreeRoot: string;
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = os.homedir();
  const defaultRoots = [
    path.join(home, '.agents', 'skills'),
    path.join(home, '.pi', 'agent', 'skills'),
    path.join(home, '.pi'),
  ];
  return {
    port: Number(env.ATEAM_PORT ?? 4319),
    dbPath: env.ATEAM_DB ?? path.join(process.cwd(), 'data', 'ateam.sqlite'),
    defaultModel: env.ATEAM_DEFAULT_MODEL ?? 'auto',
    fakeSdk: env.ATEAM_FAKE_SDK === '1' || env.NODE_ENV === 'test',
    skillHomeRoots: [...defaultRoots, ...splitList(env.ATEAM_SKILL_HOME_ROOTS)],
    isProduction: env.NODE_ENV === 'production',
    webDistDir: path.join(process.cwd(), 'dist', 'web'),
    // Git worktrees MUST live outside any project/app repo. Always resolve to an
    // absolute temp location so `git` operations can never run inside this repo
    // (a relative path here previously caused the app to commit into its own repo).
    worktreeRoot: path.resolve(
      env.ATEAM_WORKTREE_ROOT ?? path.join(os.tmpdir(), 'ateam-worktrees'),
    ),
  };
}
