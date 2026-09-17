// @ts-nocheck
/**
 * ateam eval harness — engine.
 *
 * Launches an ISOLATED ateam server (own port, DB, worktree root), drives it
 * through the real REST API + WebSocket, monitors delivery, and scores the
 * outcome. Works in two modes:
 *   - fake  (ATEAM_FAKE_SDK=1): deterministic, no auth, fast — self-tests the
 *           harness plumbing end to end (epic → PR → merge).
 *   - real  (default): the actual Copilot SDK — needs `copilot` authenticated.
 *
 * Nothing here touches the app's own repo: all state lives under an isolated
 * scratch dir in the OS temp area; reports are written under evals/reports/.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { WebSocket } from 'ws';
import Database from 'better-sqlite3';

const BUILTIN_MODULES = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');
export const REPORTS_DIR = path.join(__dirname, 'reports');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal fetch-based API client bound to a base URL. */
class Api {
  constructor(base) {
    this.base = base;
  }
  async req(method, p, body) {
    const res = await fetch(this.base + p, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const msg = json?.message || json?.error || text || res.statusText;
      throw new Error(`${method} ${p} → ${res.status} ${msg}`);
    }
    return json;
  }
  get(p) {
    return this.req('GET', p);
  }
  post(p, body) {
    return this.req('POST', p, body);
  }
  patch(p, body) {
    return this.req('PATCH', p, body);
  }
  del(p) {
    return this.req('DELETE', p);
  }
}

export class EvalHarness {
  /**
   * @param {object} opts
   * @param {string} opts.name       scenario name (used for scratch + report)
   * @param {boolean} [opts.fake]    fake adapter (default false = real SDK)
   * @param {number} [opts.port]     server port (default 4600)
   * @param {string} [opts.model]    default model override (real mode)
   */
  constructor(opts) {
    this.name = opts.name;
    this.fake = !!opts.fake;
    this.port = opts.port ?? 4600;
    this.model = opts.model;
    this.base = `http://localhost:${this.port}`;
    this.api = new Api(this.base);
    this.runId = `${opts.name}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    this.scratch = path.join(os.tmpdir(), 'ateam-evals', this.runId);
    this.dbPath = path.join(this.scratch, 'ateam.sqlite');
    this.worktreeRoot = path.join(this.scratch, 'worktrees');
    this.logPath = path.join(this.scratch, 'server.log');
    this.eventsPath = path.join(this.scratch, 'events.jsonl');
    this.events = []; // captured WS messages
    this.authWarned = false;
    this.baselineFiles = new Set(); // repo files present BEFORE agents run
    fs.mkdirSync(this.scratch, { recursive: true });
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }

  log(...a) {
    console.log(`[eval:${this.name}]`, ...a);
  }

  /* ------------------------------------------------------- server lifecycle */

  async start() {
    const env = {
      ...process.env,
      ATEAM_PORT: String(this.port),
      ATEAM_DB: this.dbPath,
      ATEAM_WORKTREE_ROOT: this.worktreeRoot,
      ATEAM_FAKE_SDK: this.fake ? '1' : '0',
      NODE_ENV: 'development',
    };
    if (this.model) env.ATEAM_DEFAULT_MODEL = this.model;
    const logFd = fs.openSync(this.logPath, 'a');
    this.log(`starting server on ${this.port} (adapter: ${this.fake ? 'fake' : 'real'})`);
    this.child = spawn(
      process.execPath,
      ['--import', 'tsx', path.join('src', 'server', 'index.ts')],
      { cwd: REPO_ROOT, env, stdio: ['ignore', logFd, logFd] },
    );
    this.child.on('exit', (code) => {
      if (code && code !== 0 && !this.stopping)
        this.log(`server exited unexpectedly (code ${code})`);
    });
    await this.waitHealthy();
    this.connectWs();
    return this;
  }

  async waitHealthy(timeoutMs = 60_000) {
    const t0 = Date.now();
    for (;;) {
      try {
        const h = await this.api.get('/api/health');
        if (h?.ok) {
          this.log('server healthy');
          return;
        }
      } catch {
        /* not up yet */
      }
      if (Date.now() - t0 > timeoutMs) {
        const tail = this.tailLog(40);
        throw new Error(
          `server not healthy after ${timeoutMs}ms.\n--- server.log tail ---\n${tail}`,
        );
      }
      await sleep(500);
    }
  }

  connectWs() {
    this.ws = new WebSocket(`ws://localhost:${this.port}/ws`);
    this.ws.on('message', (buf) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch {
        return;
      }
      msg._t = Date.now();
      this.events.push(msg);
      fs.appendFileSync(this.eventsPath, JSON.stringify(msg) + '\n');
    });
    this.ws.on('error', () => undefined);
  }

  tailLog(n = 40) {
    try {
      return fs.readFileSync(this.logPath, 'utf8').split('\n').slice(-n).join('\n');
    } catch {
      return '(no log)';
    }
  }

  async stop() {
    this.stopping = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    if (this.child && !this.child.killed) {
      // Kill the whole tree on Windows; SIGTERM elsewhere.
      if (process.platform === 'win32') {
        try {
          execFileSync('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], {
            stdio: 'ignore',
          });
        } catch {
          /* already gone */
        }
      } else {
        this.child.kill('SIGTERM');
      }
    }
    await sleep(300);
  }

  /* --------------------------------------------------------- driving the app */

  /**
   * Auth is judged from the SERVER log (warm-up prints a specific hint when the
   * SDK is unauthenticated) — never from agent/tool content, which legitimately
   * mentions words like "unauthorized" (e.g. a REST API's 401 handling).
   */
  detectAuthIssue() {
    try {
      const log = fs.readFileSync(this.logPath, 'utf8');
      return /not authenticated|authenticate first/i.test(log);
    } catch {
      return false;
    }
  }

  /**
   * A run is ENVIRONMENT-INVALID when the model provider itself refused to
   * generate - most commonly an exhausted Copilot quota (HTTP 402) or a provider
   * outage. The adapter now logs a greppable `[copilot] session error (...)` line
   * for these; without this the whole team just produces empty turns and the
   * scenario looks like a genuine AC4/AC5 failure when in fact NOTHING could run.
   * Returns the first matching diagnostic so callers can surface it instead of
   * scoring behavior that never happened.
   */
  detectEnvironmentIssue() {
    try {
      const log = fs.readFileSync(this.logPath, 'utf8');
      const m =
        /\[copilot\] session error \([^)]*\)[^\n]*/i.exec(log) ??
        /exceeded your monthly quota[^\n]*/i.exec(log) ??
        /\bquota\b[^\n]*exceeded[^\n]*/i.exec(log);
      return m ? { invalid: true, reason: m[0].slice(0, 300) } : { invalid: false, reason: '' };
    } catch {
      return { invalid: false, reason: '' };
    }
  }

  async createProject(name, repoDir, settings = {}) {
    const { project } = await this.api.post('/api/projects', { name, repoDir });
    this.projectId = project.id;
    this.repoDir = repoDir;
    // Snapshot the repo BEFORE any agent work so deliverables can be measured as
    // "what the team added/changed", not the pre-existing tree (brownfield).
    this.baselineFiles = new Set(this.gitTrackedFiles(repoDir));
    if (Object.keys(settings).length) await this.api.patch(`/api/projects/${project.id}`, settings);
    this.log(`project ${project.id} → ${repoDir}`);
    return project;
  }

  /** Add a full or custom roster. `roster` is an array of catalogId (+ optional {model}). */
  async addTeam(roster) {
    for (const entry of roster) {
      const catalogId = typeof entry === 'string' ? entry : entry.catalogId;
      const extra = typeof entry === 'string' ? {} : entry;
      try {
        await this.api.post(`/api/projects/${this.projectId}/agents`, { catalogId, ...extra });
        this.log(`+ agent ${catalogId}`);
      } catch (e) {
        this.log(`! agent ${catalogId} skipped: ${e.message}`);
      }
    }
    const { agents } = await this.api.get(`/api/projects/${this.projectId}/agents`);
    return agents;
  }

  sendChat(content) {
    return this.api.post(`/api/projects/${this.projectId}/chat`, { content });
  }

  async createEpic(title, description) {
    const { workItem } = await this.api.post(`/api/projects/${this.projectId}/workitems`, {
      kind: 'epic',
      title,
      description,
    });
    this.log(`epic ${workItem.id}: ${title}`);
    return workItem;
  }

  /* --------------------------------------------------------------- monitoring */

  /** One condensed snapshot of the project's delivery state. */
  /** Fetch the persisted verification reports (deterministic gate audit trail). */
  async verification() {
    try {
      const { reports } = await this.api.get(
        `/api/projects/${this.projectId}/verification?limit=500`,
      );
      return reports ?? [];
    } catch {
      return [];
    }
  }

  async snapshot() {
    const bundle = await this.api.get(`/api/projects/${this.projectId}`);
    const items = bundle.workItems ?? [];
    const epics = items.filter((i) => i.kind === 'epic');
    const tasks = items.filter((i) => i.kind !== 'epic');
    const byStatus = (list) =>
      list.reduce((m, i) => ((m[i.status] = (m[i.status] ?? 0) + 1), m), {});
    let pulls = [];
    try {
      ({ pulls } = await this.api.get(`/api/projects/${this.projectId}/pulls`));
    } catch {
      /* ignore */
    }
    return {
      epics,
      tasks,
      epicStatus: byStatus(epics),
      taskStatus: byStatus(tasks),
      pulls: pulls ?? [],
      agents: bundle.agents ?? [],
    };
  }

  /**
   * Poll until `until(snapshot)` is true or the timeout elapses, printing a
   * compact status line each interval.
   */
  async monitorUntil(until, { timeoutMs = 45 * 60_000, intervalMs = 5000 } = {}) {
    const t0 = Date.now();
    let last = '';
    let lastSnap = {
      epics: [],
      tasks: [],
      epicStatus: {},
      taskStatus: {},
      pulls: [],
      agents: [],
    };
    let fails = 0;
    const MAX_FAILS = 6; // ~30s of unreachable server => treat as crashed
    for (;;) {
      let snap;
      try {
        snap = await this.snapshot();
        fails = 0;
        lastSnap = snap;
      } catch (err) {
        fails += 1;
        this.log(`⚠ snapshot failed (${fails}/${MAX_FAILS}): ${err.message ?? err}`);
        if (fails >= MAX_FAILS) {
          this.log('⚠ server appears to have crashed mid-run — ending monitor.');
          return { done: false, crashed: true, snap: lastSnap, elapsedMs: Date.now() - t0 };
        }
        if (Date.now() - t0 > timeoutMs)
          return { done: false, snap: lastSnap, elapsedMs: Date.now() - t0 };
        await sleep(intervalMs);
        continue;
      }
      const el = Math.round((Date.now() - t0) / 1000);
      const merged = snap.pulls.filter((p) => p.status === 'merged').length;
      const line =
        `t+${el}s | epics ${JSON.stringify(snap.epicStatus)} | ` +
        `tasks ${JSON.stringify(snap.taskStatus)} | PRs ${snap.pulls.length} (merged ${merged})`;
      if (line !== last) {
        this.log(line);
        last = line;
      }
      if (until(snap, this)) return { done: true, snap, elapsedMs: Date.now() - t0 };
      if (Date.now() - t0 > timeoutMs) return { done: false, snap, elapsedMs: Date.now() - t0 };
      await sleep(intervalMs);
    }
  }

  /* ------------------------------------------------------------- scoring */

  /** Files tracked on the target repo's default branch (post-merge deliverables). */
  gitTrackedFiles(dir = this.repoDir) {
    try {
      return execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], {
        cwd: dir,
        encoding: 'utf8',
      })
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Pull the chat transcript for the report. */
  async chat() {
    try {
      const { messages } = await this.api.get(`/api/projects/${this.projectId}/chat`);
      return messages ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Every git clone the team worked in under the worktree root: the per-epic
   * clone AND the per-task clones nested under `.tasks-<epicId>/wi_<taskId>/`.
   * Un-integrated task clones are where real source often still lives while an
   * epic is mid-flight, so faithfulness scoring MUST see them (otherwise an
   * empty epic clone reads as trivially "faithful").
   */
  cloneDirs() {
    const dirs = [];
    try {
      const projDir = path.join(this.worktreeRoot, this.projectId ?? '');
      if (!fs.existsSync(projDir)) return dirs;
      for (const name of fs.readdirSync(projDir)) {
        const full = path.join(projDir, name);
        try {
          if (!fs.statSync(full).isDirectory()) continue;
        } catch {
          continue;
        }
        if (name.startsWith('.tasks-')) {
          for (const t of fs.readdirSync(full)) {
            const tf = path.join(full, t);
            try {
              if (fs.statSync(tf).isDirectory()) dirs.push(tf);
            } catch {
              /* ignore */
            }
          }
        } else {
          dirs.push(full); // per-epic clone
        }
      }
    } catch {
      /* no clones / fs unavailable */
    }
    return dirs;
  }

  /**
   * Files the team ADDED or changed, regardless of merge state: new files on the
   * default branch (vs the pre-run baseline) plus files changed on any active
   * epic- OR task-branch clone under the worktree root. Excludes ateam bookkeeping.
   */
  collectDeliverables() {
    const out = new Set();
    const keep = (f) =>
      f && !f.startsWith('.ateam') && f !== '.ateam-keep' && !f.startsWith('.git');
    // 1. New files merged onto the default branch (vs baseline).
    for (const f of this.gitTrackedFiles(this.repoDir)) {
      if (keep(f) && !this.baselineFiles.has(f)) out.add(f);
    }
    // 2. Files changed on epic/task clones that have not merged yet.
    try {
      for (const dir of this.cloneDirs()) {
        let base = '';
        try {
          base = execFileSync('git', ['merge-base', 'HEAD', 'main'], {
            cwd: dir,
            encoding: 'utf8',
          }).trim();
        } catch {
          try {
            base = execFileSync('git', ['merge-base', 'HEAD', 'master'], {
              cwd: dir,
              encoding: 'utf8',
            }).trim();
          } catch {
            base = '';
          }
        }
        if (!base) continue;
        const names = execFileSync('git', ['diff', '--name-only', `${base}..HEAD`], {
          cwd: dir,
          encoding: 'utf8',
        })
          .split('\n')
          .map((s) => s.trim())
          .filter(keep);
        for (const f of names) out.add(f);
      }
    } catch {
      /* no clones / git unavailable */
    }
    return [...out];
  }

  /**
   * Inspect the delivered files for faithfulness signals used by the `headless`
   * scenario (and useful generally): whether any UI files were produced, the set
   * of external RUNTIME dependencies declared, and whether the code persists
   * state to disk. Reads each deliverable from the default branch first, then any
   * epic-branch clone. Heuristic but server-authoritative on file NAMES + content.
   */
  analyzeDelivery(deliverables) {
    const readAnywhere = (rel) => {
      const candidates = [path.join(this.repoDir, rel)];
      for (const d of this.cloneDirs()) candidates.push(path.join(d, rel));
      for (const c of candidates) {
        try {
          if (fs.existsSync(c) && fs.statSync(c).isFile()) return fs.readFileSync(c, 'utf8');
        } catch {
          /* ignore */
        }
      }
      return '';
    };
    const uiFiles = deliverables.filter((f) => /\.(tsx|jsx|vue|svelte)$/i.test(f));
    const runtimeDeps = new Set();
    for (const f of deliverables.filter((f) => /(^|\/)package\.json$/.test(f))) {
      try {
        const pkg = JSON.parse(readAnywhere(f));
        for (const k of Object.keys(pkg.dependencies ?? {})) runtimeDeps.add(k);
      } catch {
        /* unreadable/invalid */
      }
    }
    let writesToDisk = false;
    for (const f of deliverables.filter(
      (f) => /\.(js|mjs|cjs|ts)$/i.test(f) && !/(test|spec|\.d\.ts$)/i.test(f),
    )) {
      const src = readAnywhere(f);
      if (/\b(writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream)\b/.test(src)) {
        writesToDisk = true;
        break;
      }
    }
    // External bare imports in shipped (non-test) source - catches a dependency
    // the build used WITHOUT declaring it in package.json. Deterministic, mirrors
    // src/server/constraints.ts so the eval never has to trust the model.
    const importRe = /\b(?:import\b[^'"]*?from\s*|import\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
    for (const f of deliverables.filter(
      (f) => /\.(js|mjs|cjs|jsx|ts|tsx)$/i.test(f) && !/(test|spec|\.d\.ts$)/i.test(f),
    )) {
      const src = readAnywhere(f);
      importRe.lastIndex = 0;
      let m;
      while ((m = importRe.exec(src))) {
        const spec = m[1];
        if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:'))
          continue;
        const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        if (!BUILTIN_MODULES.has(pkg)) runtimeDeps.add(pkg);
      }
    }
    return { uiFileCount: uiFiles.length, runtimeDeps: [...runtimeDeps], writesToDisk };
  }

  /**
   * Read the Architect/Lead technical designs persisted for each epic (AC5).
   * Opens the live sqlite db READ-ONLY (safe against the server's WAL); degrades
   * to [] on any error so scoring never crashes. Returns [{ epicId, content }].
   */
  readEpicDesigns() {
    let db;
    try {
      db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
      const rows = db.prepare('SELECT epic_id AS epicId, content FROM epic_designs').all();
      return rows.map((r) => ({ epicId: r.epicId, content: String(r.content ?? '') }));
    } catch {
      return [];
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Attribute changed files to the STREAM that produced them (AC4). Each task
   * clone dir's basename IS the full task id (`.tasks-<epicId>/<taskId>`), so we
   * map dir -> task.stream from the snapshot and git-diff it vs its merge-base.
   * Also diffs each task's `branch` in the epic/target clones so attribution
   * survives a clone that was GC'd after merge. Returns { [stream]: string[] }.
   */
  deliverablesByStream(tasks = []) {
    const keep = (f) => f && !f.startsWith('.ateam') && f !== '.ateam-keep' && !f.startsWith('.git');
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const buckets = {};
    const add = (stream, files) => {
      if (!stream || !files.length) return;
      (buckets[stream] ??= new Set());
      for (const f of files) if (keep(f)) buckets[stream].add(f);
    };
    const diffNames = (dir, range) => {
      try {
        return execFileSync('git', ['diff', '--name-only', range], { cwd: dir, encoding: 'utf8' })
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
      } catch {
        return [];
      }
    };
    const mergeBase = (dir) => {
      for (const b of ['main', 'master']) {
        try {
          return execFileSync('git', ['merge-base', 'HEAD', b], { cwd: dir, encoding: 'utf8' }).trim();
        } catch {
          /* try next */
        }
      }
      return '';
    };
    // 1. Per-task clones (primary attribution: dir basename == task id).
    for (const dir of this.cloneDirs()) {
      const task = byId.get(path.basename(dir));
      if (!task) continue; // epic clone (basename != task id) — skip; task clones only
      const base = mergeBase(dir);
      if (base) add(task.stream, diffNames(dir, `${base}..HEAD`));
    }
    // 2. Branch-based attribution (survives clone GC): diff each task's branch in
    //    the target repo and any clone that has the ref.
    const searchDirs = [this.repoDir, ...this.cloneDirs()];
    for (const task of tasks) {
      if (!task.branch) continue;
      for (const dir of searchDirs) {
        for (const b of ['main', 'master']) {
          const names = diffNames(dir, `${b}...${task.branch}`);
          if (names.length) {
            add(task.stream, names);
            break;
          }
        }
      }
    }
    const out = {};
    for (const [k, v] of Object.entries(buckets)) out[k] = [...v];
    return out;
  }

  /** Build a structured outcome + a human-readable markdown report. */
  async report(scenario, monitorResult) {
    const snap = monitorResult.snap;
    const deliverables = this.collectDeliverables();
    const merged = snap.pulls.filter((p) => p.status === 'merged');
    const chat = await this.chat();
    const faithfulness = this.analyzeDelivery(deliverables);
    const taskStreams = [
      ...new Set((snap.tasks ?? []).map((t) => t.stream).filter(Boolean)),
    ];

    // Deterministic verification-gate signals (server-authoritative audit trail).
    const reports = await this.verification();
    const latestByItem = new Map();
    for (const r of reports) if (!latestByItem.has(r.workItemId)) latestByItem.set(r.workItemId, r);
    const terminalTasks = (snap.tasks ?? []).filter(
      (t) => t.status === 'done' || t.status === 'review',
    );
    // Invariant: no task may sit in a terminal state while its LATEST gate report
    // is a genuine failure (must be 0).
    const tasksDoneWithFailingGate = terminalTasks.filter((t) => {
      const r = latestByItem.get(t.id);
      return r && r.outcome === 'failed';
    }).length;
    const verificationReports = reports.length;
    const gateFailures = reports.filter((r) => r.outcome === 'failed').length;
    const gateOverrides = reports.filter((r) => r.outcome === 'skipped').length;
    // MAJOR-1: the deterministic acceptance-probe check on the epic-scoped reports.
    // 'pass'/'fail' when a probe ran on any epic; 'skip' when none did.
    let acceptanceProbe = 'skip';
    for (const r of reports) {
      if (r.scope !== 'epic') continue;
      const c = (r.checks ?? []).find((x) => x.id === 'acceptance-probe');
      if (!c) continue;
      if (c.status === 'fail') {
        acceptanceProbe = 'fail';
        break;
      }
      if (c.status === 'pass') acceptanceProbe = 'pass';
    }

    // Event-derived signals (server-authoritative, not fuzzy keyword matches).
    const evStr = this.events.map((e) => JSON.stringify(e)).join('\n');
    const qaSignoff = /QA gate: .* passed/.test(evStr);
    const authIssue = this.detectAuthIssue();
    const env = this.detectEnvironmentIssue();

    // --- design-first signals (AC4/AC5) -------------------------------------
    const designs = this.readEpicDesigns();
    const byStream = this.deliverablesByStream(snap.tasks ?? []);
    const df = scoreDesignFirst({
      designs,
      tasks: snap.tasks ?? [],
      deliverables,
      byStream,
      events: this.events,
    });

    const outcome = {
      scenario: scenario.name,
      adapter: this.fake ? 'fake' : 'real',
      completed: monitorResult.done,
      crashed: monitorResult.crashed === true,
      elapsedSec: Math.round(monitorResult.elapsedMs / 1000),
      epics: snap.epics.map((e) => ({ id: e.id, title: e.title, status: e.status })),
      epicsDone: snap.epics.filter((e) => e.status === 'done').length,
      epicsTotal: snap.epics.length,
      tasksByStatus: snap.taskStatus,
      prs: snap.pulls.map((p) => ({ title: p.title, status: p.status })),
      prsMerged: merged.length,
      deliverableFiles: deliverables,
      deliverableCount: deliverables.length,
      taskStreams,
      uiFileCount: faithfulness.uiFileCount,
      runtimeDeps: faithfulness.runtimeDeps,
      writesToDisk: faithfulness.writesToDisk,
      verificationReports,
      gateFailures,
      gateOverrides,
      tasksDoneWithFailingGate,
      acceptanceProbe,
      qaSignoff,
      authIssue,
      environmentInvalid: env.invalid,
      environmentError: env.reason,
      // design-first (AC4/AC5)
      designPersisted: df.designPersisted,
      designStatedStack: df.designStatedStack,
      designEnrichedTasks: df.designEnrichedTasks,
      frontendStreamTerminal: df.frontendStreamTerminal,
      frontendProducedCode: df.frontendProducedCode,
      streamsWithCode: df.streamsWithCode,
      frontendFiles: df.frontendFiles,
      userQuestionsRaised: df.userQuestionsRaised,
    };

    const md = renderReport(scenario, outcome, chat, this);
    const reportPath = path.join(REPORTS_DIR, `${this.runId}.md`);
    fs.writeFileSync(reportPath, md);
    const jsonPath = path.join(REPORTS_DIR, `${this.runId}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(outcome, null, 2));
    this.log(`report → ${path.relative(REPO_ROOT, reportPath)}`);
    return { outcome, reportPath, jsonPath };
  }
}

/* ---------------------------------------------------------- report rendering */

/**
 * Pure AC4/AC5 scoring over already-collected inputs (so it is unit-testable
 * without a live server or the fake adapter).
 *  - AC5: designPersisted (non-empty epic design), designStatedStack (names a
 *    CONCRETE technology, not the meta-word "stack"), designEnrichedTasks (a
 *    <!--design-acceptance--> marker reached a task).
 *  - AC4: frontendProducedCode — primary = code attributed to the frontend
 *    stream; guarded fallback = frontend terminal + real code landed + frontend
 *    is the SOLE code-authoring builder (architect designs, qa tests).
 */
export function scoreDesignFirst({ designs = [], tasks = [], deliverables = [], byStream = {}, events = [] }) {
  const CODE_RE = /\.(js|mjs|cjs|jsx|ts|tsx|html|css|vue|svelte)$/i;
  const TEST_RE = /(test|spec)/i;
  const STACK_RE =
    /\b(html|css|javascript|typescript|react|vue|svelte|preact|lit|vanilla|node(?:\.js)?|express|fastify|vite|webpack|tailwind|jest|vitest|playwright)\b/i;
  const NON_BUILDER = new Set(['architect', 'qa', 'docs', 'reviewer', 'security', 'pm', 'product']);

  const designPersisted = designs.some((d) => (d.content ?? '').trim().length > 0);
  const designStatedStack = designs.some((d) => STACK_RE.test(d.content ?? ''));
  const designEnrichedTasks = tasks.some((t) => (t.description ?? '').includes('<!--design-acceptance-->'));

  const streamsWithCode = Object.keys(byStream).filter((s) => (byStream[s] ?? []).some((f) => CODE_RE.test(f)));
  const frontendFiles = byStream.frontend ?? [];
  const frontendAttributedCode = frontendFiles.some((f) => CODE_RE.test(f) && !TEST_RE.test(f));
  const builderStreams = [
    ...new Set(tasks.map((t) => t.stream).filter((s) => s && !NON_BUILDER.has(s))),
  ];
  const frontendStreamTerminal = tasks.some(
    (t) => t.stream === 'frontend' && (t.status === 'review' || t.status === 'done'),
  );
  const codeDeliverableExists = deliverables.some((f) => CODE_RE.test(f) && !TEST_RE.test(f));
  const frontendFallback =
    !frontendAttributedCode &&
    frontendStreamTerminal &&
    codeDeliverableExists &&
    builderStreams.length > 0 &&
    builderStreams.every((s) => s === 'frontend');
  const frontendProducedCode = frontendAttributedCode || frontendFallback;

  const questionIds = new Set();
  for (const e of events) {
    if (e.type === 'question.updated') questionIds.add(e.question?.id ?? JSON.stringify(e.question ?? e));
  }
  return {
    designPersisted,
    designStatedStack,
    designEnrichedTasks,
    frontendStreamTerminal,
    frontendProducedCode,
    streamsWithCode,
    frontendFiles,
    userQuestionsRaised: questionIds.size,
  };
}

function renderReport(scenario, o, chat, h) {
  const check = (b) => (b ? '✅' : '❌');
  const lines = [];
  lines.push(`# Eval report — ${scenario.name}`);
  lines.push('');
  lines.push(`- **Adapter:** ${o.adapter}`);
  lines.push(`- **Completed within window:** ${check(o.completed)} (${o.elapsedSec}s)`);
  if (o.crashed)
    lines.push(
      `- **⚠ SERVER CRASHED mid-run** — results below are the last snapshot before it died.`,
    );
  if (o.environmentInvalid)
    lines.push(
      `- **⛔ ENVIRONMENT INVALID** — the model provider refused to generate ` +
        `(e.g. exhausted quota / 402): \`${o.environmentError}\`. Every agent turn ` +
        `resolves empty, so AC4/AC5 behavior below is NOT evaluable this run.`,
    );
  lines.push(`- **Epics done:** ${o.epicsDone}/${o.epicsTotal}`);
  lines.push(`- **PRs merged:** ${o.prsMerged}/${o.prs.length}`);
  lines.push(`- **Deliverable files on default branch:** ${o.deliverableCount}`);
  lines.push(`- **QA sign-off observed:** ${check(o.qaSignoff)}`);
  if (o.taskStreams)
    lines.push(`- **Task streams:** ${o.taskStreams.length ? o.taskStreams.join(', ') : '(none)'}`);
  if (o.runtimeDeps)
    lines.push(
      `- **External runtime deps:** ${o.runtimeDeps.length ? o.runtimeDeps.join(', ') : '(none)'} | **UI files:** ${o.uiFileCount} | **writes to disk:** ${check(o.writesToDisk)}`,
    );
  if (o.authIssue) lines.push(`- **⚠ AUTH ISSUE detected** — SDK appeared unauthenticated.`);
  if (o.designPersisted !== undefined) {
    lines.push(
      `- **Design-first (AC5):** persisted ${check(o.designPersisted)} | stated a stack ${check(o.designStatedStack)} | enriched tasks ${check(o.designEnrichedTasks)}`,
    );
    lines.push(
      `- **Frontend (AC4):** produced code ${check(o.frontendProducedCode)} | stream terminal ${check(o.frontendStreamTerminal)} | streams with code: ${o.streamsWithCode?.length ? o.streamsWithCode.join(', ') : '(none)'} | user questions raised: ${o.userQuestionsRaised}`,
    );
    if (o.frontendFiles?.length)
      lines.push(`- **Frontend files:** ${o.frontendFiles.slice(0, 20).map((f) => '`' + f + '`').join(', ')}`);
  }
  if (o.verificationReports !== undefined)
    lines.push(
      `- **Verification reports:** ${o.verificationReports} (failures ${o.gateFailures}, overrides ${o.gateOverrides}) | **tasks terminal with a failing gate:** ${o.tasksDoneWithFailingGate} ${o.tasksDoneWithFailingGate === 0 ? '✅' : '❌'}`,
    );
  if (o.acceptanceProbe && o.acceptanceProbe !== 'skip')
    lines.push(
      `- **Acceptance probe (MAJOR-1):** ${o.acceptanceProbe} ${o.acceptanceProbe === 'pass' ? '✅' : '❌'}`,
    );
  lines.push('');
  lines.push(`## Epics`);
  for (const e of o.epics)
    lines.push(`- ${check(e.status === 'done')} \`${e.status}\` — ${e.title}`);
  if (!o.epics.length) lines.push('- (none)');
  lines.push('');
  lines.push(`## Pull requests`);
  for (const p of o.prs)
    lines.push(`- ${check(p.status === 'merged')} \`${p.status}\` — ${p.title}`);
  if (!o.prs.length) lines.push('- (none)');
  lines.push('');
  lines.push(`## Deliverable files (default branch)`);
  for (const f of o.deliverableFiles.slice(0, 100)) lines.push(`- \`${f}\``);
  if (!o.deliverableFiles.length) lines.push('- (none — nothing landed on the default branch)');
  lines.push('');
  if (scenario.acceptance) {
    lines.push(`## Acceptance checks`);
    for (const a of scenario.acceptance) {
      const pass = safeCheck(a.check, o);
      lines.push(`- ${check(pass)} ${a.label}`);
    }
    lines.push('');
  }
  lines.push(`## Team Lead chat (last 40)`);
  for (const m of chat.slice(-40)) {
    const who = m.role === 'user' ? 'USER' : m.authorAgentId || 'agent';
    lines.push('');
    lines.push(`**[${who}]**`);
    lines.push('');
    lines.push((m.content || '').slice(0, 1500));
  }
  lines.push('');
  lines.push(`---`);
  lines.push(`Scratch: \`${h.scratch}\``);
  lines.push(`Events: \`${h.eventsPath}\` (${h.events.length} messages)`);
  lines.push(`Server log: \`${h.logPath}\``);
  return lines.join('\n');
}

function safeCheck(fn, o) {
  try {
    return !!fn(o);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------ repo helpers */

/** Create a fresh empty git repo at `dir` (greenfield target). */
export function makeGreenfieldRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'eval'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'eval@local'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# eval target (greenfield)\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

/** Clone an existing repo (brownfield target) at an optional ref. */
export function makeBrownfieldRepo(dir, source, ref) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  execFileSync('git', ['clone', '--quiet', source, dir], { stdio: 'inherit' });
  if (ref) execFileSync('git', ['checkout', '--quiet', ref], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'eval'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'eval@local'], { cwd: dir });
  return dir;
}

export { sleep };
