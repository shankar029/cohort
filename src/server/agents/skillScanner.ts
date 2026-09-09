import fs from 'node:fs';
import path from 'node:path';
import type { SkillInfo } from '@shared/index';

const MAX_DEPTH = 5;
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.venv',
]);

/** Parse the `name` and `description` from a SKILL.md YAML frontmatter block. */
export function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const body = match[1]!;
  const get = (key: string): string | undefined => {
    const m = body.match(new RegExp(`^${key}\\s*:\\s*(.+)$`, 'm'));
    if (!m) return undefined;
    return m[1]!.trim().replace(/^["']|["']$/g, '');
  };
  return { name: get('name'), description: get('description') };
}

function readSkill(skillMdPath: string, source: SkillInfo['source']): SkillInfo | null {
  try {
    const content = fs.readFileSync(skillMdPath, 'utf8');
    const fm = parseSkillFrontmatter(content);
    const dir = path.dirname(skillMdPath);
    return {
      name: fm.name ?? path.basename(dir),
      description: fm.description ?? '',
      path: dir,
      source,
    };
  } catch {
    return null;
  }
}

function walk(
  root: string,
  source: SkillInfo['source'],
  out: Map<string, SkillInfo>,
  depth = 0,
): void {
  if (depth > MAX_DEPTH) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === 'SKILL.md') {
      const skill = readSkill(path.join(root, entry.name), source);
      if (skill) out.set(skill.path, skill); // dedupe by directory
    }
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !IGNORE_DIRS.has(entry.name) && !entry.name.startsWith('.git')) {
      walk(path.join(root, entry.name), source, out, depth + 1);
    }
  }
}

/**
 * Discover all skills available to a project: system/home roots + roots inside
 * the project's repository. Deduplicated by skill directory; project skills win.
 */
export function discoverSkills(
  homeRoots: string[],
  repoDir: string | null,
  extraRoots: string[] = [],
): SkillInfo[] {
  const home = new Map<string, SkillInfo>();
  for (const root of [...homeRoots, ...extraRoots]) {
    if (root && fs.existsSync(root)) walk(root, 'home', home);
  }

  const project = new Map<string, SkillInfo>();
  if (repoDir) {
    const projectRoots = [
      path.join(repoDir, '.agents', 'skills'),
      path.join(repoDir, 'skills'),
      path.join(repoDir, '.github', 'skills'),
    ];
    for (const root of projectRoots) {
      if (fs.existsSync(root)) walk(root, 'project', project);
    }
  }

  // Merge; project entries override home entries with the same skill name.
  const byName = new Map<string, SkillInfo>();
  for (const s of home.values()) byName.set(s.name, s);
  for (const s of project.values()) byName.set(s.name, s);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Unique parent directories of the given skills, for SDK `skillDirectories`. */
export function skillDirectories(skills: SkillInfo[]): string[] {
  const dirs = new Set<string>();
  for (const s of skills) dirs.add(path.dirname(s.path));
  return [...dirs];
}

/**
 * Per-agent skill scoping. Given every discovered skill and the names a single
 * agent was attached to, return the skill names to DISABLE for that agent's
 * session (everything discovered that the agent did NOT select). Combined with a
 * full `skillDirectories` pool this yields opt-in, name-granular scoping: an
 * agent only follows its attached skills, and skills sharing a parent directory
 * never leak into an agent that didn't select them. Empty selection => all
 * discovered skills disabled.
 */
export function scopedDisabledSkills(all: SkillInfo[], selected: string[]): string[] {
  const keep = new Set(selected);
  return all.filter((s) => !keep.has(s.name)).map((s) => s.name);
}
