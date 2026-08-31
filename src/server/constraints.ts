/**
 * Deterministic delivery-constraint guardrails.
 *
 * Live run #3 showed that anchoring review/acceptance prompts on the original
 * request is necessary but NOT sufficient: the backend still shipped `express`
 * despite an explicit "only Node's built-in http, no external dependencies"
 * constraint, and nothing deterministic stopped it before review. The model was
 * trusted to self-police a hard constraint; it didn't.
 *
 * This module makes the hard constraints machine-checkable. `detectConstraints`
 * reads them out of the request/criteria text with conservative regexes; nothing
 * is invented and an absent signal simply means "not enforced". `checkClone`
 * then verifies a working clone against them by scanning the delivered files -
 * runtime `dependencies`, non-builtin bare imports in shipped (non-test) source,
 * disk-persistence calls, and UI files. It never runs code and never calls an
 * LLM, so it is safe to run on the hot path of the per-task build gate.
 */
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';

export type ConstraintKind = 'no-external-deps' | 'in-memory' | 'no-ui';

export interface Constraint {
  kind: ConstraintKind;
  /** The phrase that triggered it, for transparency in logs. */
  evidence: string;
}

export interface ConstraintViolation {
  kind: ConstraintKind;
  detail: string;
  files: string[];
}

const DETECTORS: { kind: ConstraintKind; re: RegExp }[] = [
  {
    kind: 'no-external-deps',
    re: /\b(no (external |third[-\s]?party )?dependenc\w*|dependency[-\s]?free|only (using )?(node'?s? )?(built[-\s]?in|standard[-\s]?library)|standard[-\s]?library[-\s]?only|without (any )?(external )?(dependenc\w*|librar\w*|framework\w*)|no (npm|external) (packages?|deps|modules?)|vanilla (js|javascript|node)|only node'?s? built[-\s]?in http)\b/i,
  },
  {
    kind: 'in-memory',
    re: /\b(in[-\s]?memory|no (database|db|persistence|disk|data ?store)|not persist\w*|without (a )?(database|db|persistence)|state (is |lives )?(kept |held )?in memory|lost on restart|ephemeral)\b/i,
  },
  {
    kind: 'no-ui',
    re: /\b(headless|no[-\s]?ui\b|no user interface|api[-\s]?only|backend[-\s]?only|there is no ui|without (a )?(ui|user interface|frontend))\b/i,
  },
];

/**
 * Extract the machine-checkable hard constraints from any request/criteria text.
 * Conservative: a constraint is only returned when its phrase is actually present.
 */
export function detectConstraints(texts: Array<string | null | undefined>): Constraint[] {
  const blob = texts.filter(Boolean).join('\n');
  const out: Constraint[] = [];
  for (const d of DETECTORS) {
    const m = d.re.exec(blob);
    if (m) out.push({ kind: d.kind, evidence: m[0] });
  }
  return out;
}

const SRC_EXT = /\.(js|mjs|cjs|jsx|ts|tsx)$/i;
const TEST_RE = /(^|[./\\])(tests?|__tests__|spec|e2e)([./\\]|$)|\.(test|spec)\.[cm]?[jt]sx?$/i;
const UI_EXT = /\.(tsx|jsx|vue|svelte)$/i;
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'coverage',
  'dist',
  'build',
  'out',
  '.next',
  '.ateam',
]);

/** Recursively list source files under `dir` (skipping vendored/build dirs). */
function listSource(dir: string): string[] {
  const found: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.') {
        if (SKIP_DIRS.has(e.name)) continue;
      }
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(path.join(d, e.name));
      } else if (SRC_EXT.test(e.name)) {
        found.push(path.join(d, e.name));
      }
    }
  };
  walk(dir);
  return found;
}

const BUILTINS = new Set<string>([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

/** True for a bare specifier that resolves to an external npm package. */
function isExternalSpecifier(spec: string): boolean {
  if (!spec) return false;
  if (spec.startsWith('.') || spec.startsWith('/')) return false; // relative/absolute
  if (spec.startsWith('node:')) return false; // explicit builtin
  if (BUILTINS.has(spec)) return false;
  // Scoped/deep import: the package is the first (or first two, if scoped) segment.
  const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
  return !BUILTINS.has(pkg);
}

const IMPORT_RE = /\b(?:import\b[^'"]*?from\s*|import\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
const DYN_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const DISK_WRITE_RE =
  /\b(writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|promises\.writeFile|promises\.appendFile)\b/;
const DB_LIB_RE =
  /\b(better-sqlite3|sqlite3|sqlite|level|lowdb|nedb|mongodb|mongoose|pg|mysql2?|redis|ioredis|typeorm|prisma|sequelize|knex)\b/;

/**
 * Read a clone's runtime dependency manifest (package.json `dependencies` only -
 * devDependencies like vitest/typescript are legitimate test tooling and are not
 * part of a "dependency-free runtime").
 */
function runtimeDeps(dir: string): string[] {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    return Object.keys(pkg.dependencies ?? {});
  } catch {
    return [];
  }
}

/**
 * Verify a working clone against the detected constraints. Pure filesystem scan;
 * returns one violation per breached constraint with the offending files.
 */
export function checkClone(dir: string, constraints: Constraint[]): ConstraintViolation[] {
  if (constraints.length === 0) return [];
  const kinds = new Set(constraints.map((c) => c.kind));
  const violations: ConstraintViolation[] = [];
  const sources = listSource(dir);
  const shipped = sources.filter((f) => !TEST_RE.test(path.relative(dir, f)));

  if (kinds.has('no-external-deps')) {
    const deps = runtimeDeps(dir);
    const badImports = new Map<string, Set<string>>(); // module -> files
    for (const f of shipped) {
      let src: string;
      try {
        src = fs.readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      for (const re of [IMPORT_RE, DYN_IMPORT_RE]) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(src))) {
          const spec = m[1]!;
          if (isExternalSpecifier(spec)) {
            const pkg = spec.startsWith('@')
              ? spec.split('/').slice(0, 2).join('/')
              : spec.split('/')[0]!;
            if (!badImports.has(pkg)) badImports.set(pkg, new Set());
            badImports.get(pkg)!.add(path.relative(dir, f));
          }
        }
      }
    }
    const offenders = new Set<string>([...deps, ...badImports.keys()]);
    if (offenders.size > 0) {
      const files = new Set<string>();
      for (const s of badImports.values()) for (const f of s) files.add(f);
      violations.push({
        kind: 'no-external-deps',
        detail: `external dependencies used despite a dependency-free requirement: ${[...offenders].join(', ')}`,
        files: [...files],
      });
    }
  }

  if (kinds.has('in-memory')) {
    const files = new Set<string>();
    for (const f of shipped) {
      let src: string;
      try {
        src = fs.readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      if (DISK_WRITE_RE.test(src) || DB_LIB_RE.test(src)) files.add(path.relative(dir, f));
    }
    if (files.size > 0) {
      violations.push({
        kind: 'in-memory',
        detail: `state is persisted to disk/database despite an in-memory requirement`,
        files: [...files],
      });
    }
  }

  if (kinds.has('no-ui')) {
    const uiFiles = sources.filter((f) => UI_EXT.test(f)).map((f) => path.relative(dir, f));
    const deps = runtimeDeps(dir).filter((d) =>
      /\b(react|react-dom|vue|svelte|@angular)\b/.test(d),
    );
    if (uiFiles.length > 0 || deps.length > 0) {
      violations.push({
        kind: 'no-ui',
        detail: `user-interface artifacts delivered despite a headless requirement${deps.length ? ` (deps: ${deps.join(', ')})` : ''}`,
        files: uiFiles,
      });
    }
  }

  return violations;
}

/** One-line human summary for logs/escalations. */
export function summarizeViolations(violations: ConstraintViolation[]): string {
  return violations
    .map((v) => {
      const where = v.files.length ? ` [${v.files.slice(0, 5).join(', ')}]` : '';
      return `${v.kind}: ${v.detail}${where}`;
    })
    .join('; ');
}

const CONSTRAINT_DIRECTIVE: Record<ConstraintKind, string> = {
  'no-external-deps':
    'Use ONLY the language/runtime standard library. Do NOT add any third-party ' +
    'dependency, framework, or package (no new entries in package.json/requirements, ' +
    'no `npm install`). e.g. use the built-in HTTP server, not Express.',
  'in-memory':
    'Keep ALL state in memory only. Do NOT use a database, disk persistence, or any ' +
    'external datastore; data may be lost on restart.',
  'no-ui': 'This is headless / API-only. Do NOT build a UI, frontend, or browser-based interface.',
};

/**
 * Render detected hard constraints as imperative, top-of-brief directives so the
 * agent honors them on the FIRST pass (DRIFT-2), instead of the deterministic gate
 * catching a violation and forcing a costly re-drive.
 */
export function describeConstraints(constraints: Constraint[]): string {
  if (constraints.length === 0) return '';
  const lines = constraints.map((c) => `- ${CONSTRAINT_DIRECTIVE[c.kind]}`);
  return (
    `HARD CONSTRAINTS (non-negotiable - a deterministic gate WILL reject violations, ` +
    `so honoring these is part of "done"):\n${lines.join('\n')}\n`
  );
}
