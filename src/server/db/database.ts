import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

export type DB = Database.Database;

/** DDL applied once on startup. Idempotent (IF NOT EXISTS). */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_dir TEXT NOT NULL,
  settings TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL,
  prompt TEXT NOT NULL,
  tools TEXT,
  skills TEXT NOT NULL,
  model TEXT NOT NULL,
  emoji TEXT NOT NULL,
  color TEXT NOT NULL,
  catalog_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, name)
);

CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'task',
  parent_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  stream TEXT,
  depends_on TEXT NOT NULL DEFAULT '[]',
  assignee_agent_id TEXT,
  branch TEXT,
  scheduled_at INTEGER,
  recurrence TEXT NOT NULL DEFAULT 'none',
  progress INTEGER NOT NULL DEFAULT 0,
  ord REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  topic TEXT NOT NULL,
  status TEXT NOT NULL,
  work_item_id TEXT,
  participants TEXT NOT NULL DEFAULT '[]',
  includes_user INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pull_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  work_item_id TEXT,
  author_agent_id TEXT,
  reviewer_agent_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  diff TEXT NOT NULL,
  status TEXT NOT NULL,
  stats TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  work_item_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_notes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  work_item_id TEXT,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id TEXT,
  work_item_id TEXT,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL,
  author_agent_id TEXT,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id TEXT,
  question TEXT NOT NULL,
  choices TEXT,
  status TEXT NOT NULL,
  answer TEXT,
  created_at TEXT NOT NULL,
  answered_at TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  link TEXT NOT NULL DEFAULT 'chat',
  work_item_id TEXT,
  agent_id TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pr_comments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  pr_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  target_stream TEXT,
  target_agent_id TEXT,
  work_item_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_usage (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  work_item_id TEXT,
  agent_id TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  time_ms INTEGER NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS epic_designs (
  epic_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS acceptance_criteria (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  epic_id TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/** Indexes created AFTER migrations so they can reference migrated columns. */
const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_id);
CREATE INDEX IF NOT EXISTS idx_workitems_project ON work_items(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_agent ON agent_tasks(project_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_events_project ON agent_events(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_agent ON agent_events(project_id, agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_project ON chat_messages(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_thread ON chat_messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_threads_project ON threads(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_prs_project ON pull_requests(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_workitems_parent ON work_items(parent_id);
CREATE INDEX IF NOT EXISTS idx_questions_project ON questions(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_project ON notifications(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pr_comments_pr ON pr_comments(pr_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pr_comments_project ON pr_comments(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_work_usage_project ON work_usage(project_id);
CREATE INDEX IF NOT EXISTS idx_work_usage_item ON work_usage(work_item_id);
CREATE INDEX IF NOT EXISTS idx_work_usage_agent ON work_usage(project_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_criteria_epic ON acceptance_criteria(epic_id);
`;

/** Additive column migrations for databases created by an earlier schema. */
function migrate(db: DB): void {
  const cols = (table: string): Set<string> =>
    new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    );
  const add = (table: string, col: string, ddl: string): void => {
    const exists =
      (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table) as
        unknown | undefined) !== undefined;
    if (exists && !cols(table).has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  add('work_items', 'kind', "kind TEXT NOT NULL DEFAULT 'task'");
  add('work_items', 'parent_id', 'parent_id TEXT');
  add('work_items', 'stream', 'stream TEXT');
  add('work_items', 'depends_on', "depends_on TEXT NOT NULL DEFAULT '[]'");
  add('work_items', 'branch', 'branch TEXT');
  add('work_items', 'scheduled_at', 'scheduled_at INTEGER');
  add('work_items', 'recurrence', "recurrence TEXT NOT NULL DEFAULT 'none'");
  add('work_items', 'progress', 'progress INTEGER NOT NULL DEFAULT 0');
  add('chat_messages', 'thread_id', "thread_id TEXT NOT NULL DEFAULT ''");
  add('chat_messages', 'author_agent_id', 'author_agent_id TEXT');
  add('pull_requests', 'stats', "stats TEXT NOT NULL DEFAULT '{}'");
}

export function openDatabase(dbPath: string): DB {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  db.exec(INDEXES);
  return db;
}
