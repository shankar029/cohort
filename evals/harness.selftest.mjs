// @ts-nocheck
/**
 * Deterministic self-test for the design-first eval SCORING (AC4/AC5), run with:
 *   node --test evals/harness.selftest.mjs
 *
 * The fake adapter writes `.md` deliverables (not code), so it cannot exercise
 * the frontendProducedCode true-path — these tests do, without a live server:
 *  - scoreDesignFirst(): pure AC4/AC5 logic incl. the F2 (meta-word) and F3
 *    (sole-code-author fallback) guards from the design review.
 *  - readEpicDesigns() / deliverablesByStream(): against a real temp git + sqlite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { EvalHarness, scoreDesignFirst } from './harness.mjs';

/* ------------------------------------------------------- scoreDesignFirst() */

test('AC5: a concrete stack passes; the meta-word "stack" alone does not (F2)', () => {
  const named = scoreDesignFirst({ designs: [{ epicId: 'e', content: 'Use React + Vite, plain CSS.' }] });
  assert.equal(named.designPersisted, true);
  assert.equal(named.designStatedStack, true);

  const meta = scoreDesignFirst({ designs: [{ epicId: 'e', content: 'Build the smallest correct slice using a conventional stack.' }] });
  assert.equal(meta.designPersisted, true);
  assert.equal(meta.designStatedStack, false, 'meta-word "stack" must NOT count as a stated stack');

  const empty = scoreDesignFirst({ designs: [] });
  assert.equal(empty.designPersisted, false);
  assert.equal(empty.designStatedStack, false);
});

test('AC5: designEnrichedTasks reflects the <!--design-acceptance--> marker', () => {
  const yes = scoreDesignFirst({ tasks: [{ description: 'do X\n<!--design-acceptance-->\nDesign acceptance (frontend): ...' }] });
  assert.equal(yes.designEnrichedTasks, true);
  const no = scoreDesignFirst({ tasks: [{ description: 'do X' }] });
  assert.equal(no.designEnrichedTasks, false);
});

test('AC4: code attributed to the frontend stream passes; test files do not', () => {
  const s = scoreDesignFirst({
    tasks: [{ stream: 'frontend', status: 'done' }],
    byStream: { frontend: ['src/counter.js', 'index.html'], qa: ['test/counter.test.js'] },
  });
  assert.equal(s.frontendProducedCode, true);
  assert.deepEqual(s.streamsWithCode.sort(), ['frontend', 'qa']); // qa test file is still "code" by extension
  assert.ok(s.frontendFiles.includes('src/counter.js'));

  const onlyTests = scoreDesignFirst({
    tasks: [{ stream: 'frontend', status: 'done' }],
    byStream: { frontend: ['frontend.test.js'] },
  });
  assert.equal(onlyTests.frontendProducedCode, false, 'a frontend that produced only test files is not "produced code"');
});

test('AC4 fallback (F3): only credits the frontend when it is the SOLE code-authoring builder', () => {
  // clone GC'd → byStream empty, but real code landed and frontend is the only builder.
  const sole = scoreDesignFirst({
    tasks: [{ stream: 'frontend', status: 'done' }, { stream: 'qa', status: 'done' }],
    deliverables: ['app.js', 'README.md'],
    byStream: {},
  });
  assert.equal(sole.frontendProducedCode, true, 'fallback: frontend terminal + real code + sole builder');

  // A backend builder is also present → the code could be theirs → must NOT credit frontend.
  const ambiguous = scoreDesignFirst({
    tasks: [{ stream: 'frontend', status: 'done' }, { stream: 'backend', status: 'done' }],
    deliverables: ['app.js'],
    byStream: {},
  });
  assert.equal(ambiguous.frontendProducedCode, false, 'fallback must not fire when another builder could have authored the code');

  // Frontend not terminal → no fallback.
  const notTerminal = scoreDesignFirst({
    tasks: [{ stream: 'frontend', status: 'doing' }],
    deliverables: ['app.js'],
    byStream: {},
  });
  assert.equal(notTerminal.frontendProducedCode, false);
});

test('userQuestionsRaised counts distinct question.updated events', () => {
  const s = scoreDesignFirst({
    events: [
      { type: 'question.updated', question: { id: 'q1' } },
      { type: 'question.updated', question: { id: 'q1' } },
      { type: 'question.updated', question: { id: 'q2' } },
      { type: 'workitem.updated' },
    ],
  });
  assert.equal(s.userQuestionsRaised, 2);
});

/* ------------------------------ readEpicDesigns() + deliverablesByStream() */

test('readEpicDesigns reads epic_designs from the live sqlite (read-only)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-selftest-db-'));
  const dbPath = path.join(dir, 'ateam.sqlite');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE epic_designs (epic_id TEXT PRIMARY KEY, project_id TEXT, content TEXT, updated_at INTEGER)');
  db.prepare('INSERT INTO epic_designs VALUES (?,?,?,?)').run('ep_1', 'prj_1', 'Stack: TypeScript + Vite.', 1);
  db.close();

  const h = new EvalHarness({ name: 'selftest', fake: true, port: 0 });
  h.dbPath = dbPath;
  const designs = h.readEpicDesigns();
  assert.equal(designs.length, 1);
  assert.equal(designs[0].epicId, 'ep_1');
  assert.match(designs[0].content, /TypeScript \+ Vite/);
  assert.equal(scoreDesignFirst({ designs }).designStatedStack, true);

  h.dbPath = path.join(dir, 'nope.sqlite'); // missing → degrade to []
  assert.deepEqual(h.readEpicDesigns(), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('deliverablesByStream attributes a task-clone diff to that task stream', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-selftest-wt-'));
  const projectId = 'prj_1';
  const taskId = 'wi_fe1';
  const clone = path.join(root, projectId, '.tasks-ep_1', taskId);
  fs.mkdirSync(clone, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: clone });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@e');
  fs.writeFileSync(path.join(clone, 'README.md'), '# base\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'work');
  fs.mkdirSync(path.join(clone, 'src'), { recursive: true });
  fs.writeFileSync(path.join(clone, 'src', 'counter.js'), 'export const inc = (n) => n + 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'frontend work');

  const h = new EvalHarness({ name: 'selftest', fake: true, port: 0 });
  h.worktreeRoot = root;
  h.projectId = projectId;
  h.repoDir = clone;
  const byStream = h.deliverablesByStream([{ id: taskId, stream: 'frontend', status: 'done', branch: null }]);
  assert.ok((byStream.frontend ?? []).includes('src/counter.js'), 'counter.js attributed to frontend');

  const score = scoreDesignFirst({
    tasks: [{ id: taskId, stream: 'frontend', status: 'done' }],
    byStream,
  });
  assert.equal(score.frontendProducedCode, true);
  fs.rmSync(root, { recursive: true, force: true });
});
