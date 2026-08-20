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
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  assignee_agent_id TEXT,
  ord REAL NOT NULL,
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
  role TEXT NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_id);
CREATE INDEX IF NOT EXISTS idx_workitems_project ON work_items(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_agent ON agent_tasks(project_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_events_project ON agent_events(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_agent ON agent_events(project_id, agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_project ON chat_messages(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_questions_project ON questions(project_id, created_at);
`;

export function openDatabase(dbPath: string): DB {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
