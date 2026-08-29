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

-- Retrieval unit for docs: a passage, not a whole document. See chunking.ts and
-- docs/architecture/rag.md — whole-doc retrieval plus a fixed char budget meant a 44k-char doc
-- contributed only its preamble, whichever passage actually matched.
CREATE TABLE IF NOT EXISTS doc_chunks (
  id         TEXT PRIMARY KEY,
  doc_id     TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  scope      TEXT,
  slug       TEXT NOT NULL,
  title      TEXT NOT NULL,
  heading    TEXT NOT NULL DEFAULT '',
  ordinal    INTEGER NOT NULL,
  content    TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_doc_chunks_doc ON doc_chunks(doc_id);
CREATE INDEX IF NOT EXISTS idx_doc_chunks_scope ON doc_chunks(scope);

-- BM25 indexes. The porter tokenizer stems (settlement/settlements); the old one did not.
-- Kept as plain mirrors rather than external-content tables so a rebuild is a delete + insert
-- and never depends on rowid alignment with the source table.
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  id UNINDEXED, scope UNINDEXED, body, tokenize = 'porter unicode61'
);
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
  id UNINDEXED, scope UNINDEXED, body, tokenize = 'porter unicode61'
);

-- Vectors, when an embedding provider is configured. content_hash lets a backfill skip rows
-- whose text has not changed; model lets a model swap invalidate rather than silently mixing
-- incompatible vector spaces.
CREATE TABLE IF NOT EXISTS embeddings (
  owner_kind   TEXT NOT NULL,
  owner_id     TEXT NOT NULL,
  scope        TEXT,
  model        TEXT NOT NULL,
  dims         INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  vec          BLOB NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (owner_kind, owner_id)
);
CREATE INDEX IF NOT EXISTS idx_embeddings_lookup ON embeddings(owner_kind, scope);

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