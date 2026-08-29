// @ts-nocheck
/**
 * ateam eval runner — CLI.
 *
 *   node evals/run.mjs <scenario> [--fake] [--port=4600] [--timeout=45]
 *                                 [--model=auto] [--repo=<url|path>] [--ref=<git-ref>]
 *
 * Scenarios:
 *   greenfield   — medium-scale app split into 2 parallel epics (API + UI).
 *                  Validates: agents deliver, QA gates, PRs merge, files land.
 *   headless     — in-memory, dependency-free HTTP API (reproduces live run #2).
 *                  Validates FAITHFULNESS: the system scopes streams (no ux/
 *                  frontend/researcher) and honors hard constraints (no external
 *                  deps, no UI files, in-memory / no disk writes).
 *   brownfield   — a focused change on an EXISTING medium repo. Validates that
 *                  agents read + respect the established structure/conventions.
 *   smoke        — tiny greenfield task, quickest end-to-end plumbing check.
 *
 * Use `--fake` to self-test the harness (deterministic, no auth). Omit it to run
 * the real Copilot SDK (must be signed in via `copilot`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EvalHarness, makeGreenfieldRepo, makeBrownfieldRepo } from './harness.mjs';

const FULL_TEAM = [
  'product-manager',
  'architect',
  'ux-designer',
  'frontend-engineer',
  'backend-engineer',
  'qa-engineer',
  'devops-engineer',
  'docs-writer',
  'code-reviewer',
  'security-auditor',
];

/* ----------------------------------------------------------------- scenarios */

const SCENARIOS = {
  smoke: {
    name: 'smoke',
    kind: 'greenfield',
    team: ['frontend-engineer', 'qa-engineer'],
    defaultTimeoutMin: 15,
    async drive(h) {
      await h.sendChat(
        'Build a tiny, dependency-free "word count" web page: a textarea whose ' +
          'live word/character counts update as you type. Pure static HTML/CSS/JS, ' +
          'with a small tested calc module. Keep it accessible.',
      );
    },
    until: (s) => s.epics.length > 0 && s.epics.every((e) => e.status === 'done'),
    acceptance: [
      { label: 'At least one epic reached done', check: (o) => o.epicsDone >= 1 },
      { label: 'At least one PR merged', check: (o) => o.prsMerged >= 1 },
      { label: 'Real deliverable files landed', check: (o) => o.deliverableCount >= 1 },
    ],
  },

  // Reproduces live run #2's failure mode and guards the fixes: a headless,
  // in-memory, dependency-free API request. Asserts the SYSTEM scopes streams
  // (no ux/frontend/researcher) and the delivery stays faithful to the hard
  // constraints (no external deps, no UI files, in-memory / no disk writes).
  headless: {
    name: 'headless-faithful',
    kind: 'greenfield',
    // Full team ON PURPOSE: the system must scope it DOWN itself, not rely on a
    // hand-picked roster.
    team: FULL_TEAM,
    defaultTimeoutMin: 45,
    async drive(h) {
      await h.sendChat(
        'Build an in-memory URL shortener as a small Node service using ONLY ' +
          "Node's built-in http module - no external dependencies, no database, and " +
          'no files on disk (state lives in memory and is lost on restart). ' +
          'Endpoints: POST /shorten {url} -> {code}; GET /:code -> 302 redirect to ' +
          'the original URL; GET /api/stats/:code -> {code, url, hits}. Validate input ' +
          'and return correct status codes. Also ship a small standalone client library ' +
          'that talks to the service over HTTP. Plain JavaScript. Include unit and ' +
          'integration tests. This is a headless API - there is no UI.',
      );
    },
    until: (s) => s.epics.length > 0 && s.epics.every((e) => e.status === 'done'),
    acceptance: [
      { label: 'At least one epic reached done', check: (o) => o.epicsDone >= 1 },
      { label: 'At least one PR merged', check: (o) => o.prsMerged >= 1 },
      { label: 'Real deliverable files landed', check: (o) => o.deliverableCount >= 1 },
      // I1/I6 - the system scoped irrelevant streams OUT.
      {
        label: 'No UI streams spawned (ux/frontend)',
        check: (o) => !o.taskStreams.includes('ux') && !o.taskStreams.includes('frontend'),
      },
      {
        label: 'No researcher build stream spawned',
        check: (o) => !o.taskStreams.includes('researcher'),
      },
      // I2/I7 - the delivery honored the request's HARD CONSTRAINTS.
      { label: 'No external runtime dependencies', check: (o) => o.runtimeDeps.length === 0 },
      { label: 'No UI files delivered', check: (o) => o.uiFileCount === 0 },
      { label: 'In-memory (no disk persistence)', check: (o) => !o.writesToDisk },
    ],
  },

  greenfield: {
    name: 'greenfield-parallel',
    kind: 'greenfield',
    team: FULL_TEAM,
    defaultTimeoutMin: 45,
    // Two explicit epics so they run as PARALLEL epics (each its own clone).
    async drive(h) {
      await h.createEpic(
        'Tasks REST API',
        'Build a small but real REST API for a task tracker in Node (no heavy ' +
          'frameworks unless justified): CRUD for tasks (title, done, createdAt), ' +
          'plus GET /stats (counts: total/open/done) and GET /health. Validate ' +
          'input, return proper status codes, and include unit + integration ' +
          'tests and a README. Keep the code modular and idiomatic.',
      );
      await h.createEpic(
        'Task tracker Web UI',
        'Build an accessible, dependency-free web UI (static HTML/CSS/JS) for the ' +
          'task tracker: list tasks, add/toggle/delete, and show the live stats. ' +
          'It should call the REST API. Include a tested calc/render module and a ' +
          'README section on running it. WCAG-minded: labels, keyboard, aria-live.',
      );
    },
    until: (s) => s.epics.length >= 2 && s.epics.every((e) => e.status === 'done'),
    acceptance: [
      { label: 'Both epics reached done', check: (o) => o.epicsDone >= 2 },
      { label: 'At least 2 PRs merged', check: (o) => o.prsMerged >= 2 },
      { label: 'Deliverables include API + UI code', check: (o) => o.deliverableCount >= 4 },
      { label: 'QA sign-off observed', check: (o) => o.qaSignoff },
    ],
  },

  brownfield: {
    name: 'brownfield-comprehension',
    kind: 'brownfield',
    team: FULL_TEAM,
    defaultTimeoutMin: 45,
    // Default target: a medium TS repo with clear conventions. Override via --repo.
    defaultRepo: 'https://github.com/colinhacks/zod.git',
    defaultRef: undefined,
    async drive(h) {
      await h.sendChat(
        'This is an existing codebase. First STUDY it: its structure, module ' +
          'boundaries, coding style, naming, test layout, and design patterns. ' +
          'Then add a small, well-scoped improvement that a maintainer would ' +
          'accept — a focused helper or a documented edge-case fix — that STRICTLY ' +
          'follows the existing conventions (same style, same test patterns, same ' +
          'file layout). Do not restructure or reformat unrelated code. Include ' +
          "tests in the repo's existing style and keep the build/tests green. " +
          'In your report, cite the conventions you detected and how you matched them.',
      );
    },
    // Brownfield has no epic-done guarantee; stop when a PR merges or work settles.
    until: (s) =>
      s.pulls.some((p) => p.status === 'merged') ||
      (s.epics.length > 0 && s.epics.every((e) => e.status === 'done')),
    acceptance: [
      { label: 'Produced changes (a PR was raised)', check: (o) => o.prs.length >= 1 },
      { label: 'Change merged', check: (o) => o.prsMerged >= 1 },
      { label: 'No auth failure', check: (o) => !o.authIssue },
    ],
  },
};

/* --------------------------------------------------------------------- CLI */

function parseArgs(argv) {
  const args = { _: [] };
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      args[k] = v === undefined ? true : v;
    } else args._.push(a);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const name = args._[0];
  const scenario = SCENARIOS[name];
  if (!scenario) {
    console.error(`Unknown scenario "${name}". Available: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(1);
  }
  const fake = !!args.fake;
  const port = Number(args.port ?? 4600);
  const timeoutMin = Number(args.timeout ?? scenario.defaultTimeoutMin);
  const model = args.model;

  const h = new EvalHarness({ name: scenario.name, fake, port, model });

  // Prepare the target repo.
  let repoDir;
  if (scenario.kind === 'brownfield') {
    const source = args.repo ?? scenario.defaultRepo;
    const ref = args.ref ?? scenario.defaultRef;
    repoDir = path.join(h.scratch, 'target');
    if (source && (source.startsWith('http') || source.endsWith('.git'))) {
      h.log(`cloning brownfield target ${source}${ref ? '@' + ref : ''} …`);
      makeBrownfieldRepo(repoDir, source, ref);
    } else if (source) {
      // A local path: copy it into scratch so we never mutate the original.
      h.log(`copying local brownfield target ${source} …`);
      fs.cpSync(source, repoDir, { recursive: true });
    } else {
      throw new Error('brownfield needs --repo=<url|path> (or a default)');
    }
  } else {
    repoDir = path.join(h.scratch, 'target');
    makeGreenfieldRepo(repoDir);
  }

  console.log(`\n=== eval: ${scenario.name} (${fake ? 'FAKE' : 'REAL'}) ===`);
  console.log(`target repo: ${repoDir}`);
  console.log(`timeout: ${timeoutMin} min | port: ${port}\n`);

  let result;
  try {
    await h.start();
    await h.createProject(`eval-${scenario.name}`, repoDir);
    await h.addTeam(scenario.team);
    await scenario.drive(h);
    result = await h.monitorUntil(scenario.until, { timeoutMs: timeoutMin * 60_000 });
    const { outcome, reportPath } = await h.report(scenario, result);

    // Console summary + acceptance verdict.
    console.log(`\n=== outcome ===`);
    console.log(JSON.stringify(outcome, null, 2));
    let allPass = true;
    if (scenario.acceptance) {
      console.log(`\n=== acceptance ===`);
      for (const a of scenario.acceptance) {
        let pass = false;
        try {
          pass = !!a.check(outcome);
        } catch {
          pass = false;
        }
        allPass = allPass && pass;
        console.log(`${pass ? '✅' : '❌'} ${a.label}`);
      }
    }
    console.log(`\nreport: ${reportPath}`);
    if (!result.done) console.log('⚠ did NOT complete within the timeout window.');
    process.exitCode = allPass && result.done ? 0 : 1;
  } finally {
    await h.stop();
  }
}

main().catch((e) => {
  console.error('eval failed:', e);
  process.exit(1);
});
