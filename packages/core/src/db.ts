import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory (
  id          TEXT PRIMARY KEY,
  content     TEXT NOT NULL,
  category    TEXT,
  target      TEXT,
  importance  REAL NOT NULL DEFAULT 0.5,
  tags_json   TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  source      TEXT
);
CREATE INDEX IF NOT EXISTS idx_memory_category ON memory(category);
CREATE INDEX IF NOT EXISTS idx_memory_importance ON memory(importance);

CREATE TABLE IF NOT EXISTS docs (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  tags_json   TEXT NOT NULL DEFAULT '[]',
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  scope       TEXT
);
CREATE INDEX IF NOT EXISTS idx_docs_scope ON docs(scope);

CREATE TABLE IF NOT EXISTS doc_versions (
  doc_id     TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  content    TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (doc_id, version)
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  scope      TEXT NOT NULL,
  title      TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_scope ON sessions(scope);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  at         TEXT NOT NULL,
  refs_json  TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);

CREATE TABLE IF NOT EXISTS pat (
  id          TEXT PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,
  sub         TEXT NOT NULL,
  name        TEXT,
  grants_json TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  expires_at  INTEGER,
  revoked     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pat_sub ON pat(sub);

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  owner_sub   TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS context_snapshots (
  id            TEXT PRIMARY KEY,
  scope         TEXT NOT NULL UNIQUE,
  query         TEXT NOT NULL DEFAULT '',
  prompt        TEXT NOT NULL,
  chars         INTEGER NOT NULL,
  memory_hits   INTEGER NOT NULL DEFAULT 0,
  docs_count    INTEGER NOT NULL DEFAULT 0,
  session_msgs  INTEGER NOT NULL DEFAULT 0,
  assembled_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS context_briefs (
  scope       TEXT PRIMARY KEY,
  brief_json  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
`;

export interface Store {
  readonly db: DatabaseSync;
  close(): void;
}

export function openDatabase(path: string): Store {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return {
    db,
    close: () => db.close(),
  };
}