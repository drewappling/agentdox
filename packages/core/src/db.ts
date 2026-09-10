/**
 * Storage: SQLite (node:sqlite) for one process on one machine, Postgres for several front
 * doors sharing one store. Both sit behind the same small async API — `?` placeholders,
 * rows as plain objects, `tx()` for atomic groups — and the services never see the driver.
 *
 * What differs is confined here: the schema text (FTS5 virtual tables versus `tsvector`
 * columns, BLOB versus BYTEA, AUTOINCREMENT versus an identity column), and three SQL
 * fragments the services ask the `Dialect` for (a JSON-array membership test, null-safe
 * equality, and the ranked full-text query). Everything else is SQL both engines accept.
 *
 * Transactions: the callback runs with the transaction's connection bound in an
 * AsyncLocalStorage context, so a service inside `tx()` keeps calling `store.run()` and lands
 * on the right connection. SQLite has one connection, so transactions (and the statements
 * that would otherwise interleave with one across an `await`) take a lock in turn.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { Pool, types as pgTypes, type PoolClient } from 'pg';

export type Param = string | number | boolean | null | Uint8Array;
export type Row = Record<string, unknown>;

export interface RunResult {
  /** Rows changed by an INSERT, UPDATE or DELETE. */
  changes: number;
}

/** The SQL that differs between engines, as fragments the services splice into their queries. */
export interface Dialect {
  /** True when the JSON array of strings in `column` contains the bound `?`. */
  jsonArrayHas(column: string): string;
  /** `column` equals the bound `?`, with NULL equal to NULL. */
  nullEq(column: string): string;
  /**
   * Ranked full-text search over one of the index tables. Returns `id` and `score` (higher is
   * better) for rows matching the bound query (the `"term" OR "term"` form
   * `buildMatchQuery` produces), optionally within a scope, limited. Bind order:
   * query, [scope], limit.
   */
  ftsSearch(table: 'memory_fts' | 'chunk_fts' | 'message_fts', withScope: boolean): string;
}

export interface Store {
  readonly dialect: 'sqlite' | 'postgres';
  readonly sql: Dialect;
  /** For logs and health: `sqlite:<path>` or `postgres:<host>/<db> (schema <name>)`. */
  readonly description: string;
  all<T = Row>(sql: string, params?: Param[]): Promise<T[]>;
  get<T = Row>(sql: string, params?: Param[]): Promise<T | undefined>;
  run(sql: string, params?: Param[]): Promise<RunResult>;
  /** Statements without parameters, several at once (schema, DELETE-all). */
  exec(sql: string): Promise<void>;
  /** Run `fn` atomically: commit on return, roll back on throw. Re-entrant (joins the open one). */
  tx<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------------------

/** Tables both engines share, in SQL both accept; the engine-specific parts are appended. */
const COMMON_TABLES = (t: { real: string; blob: string; bigint: string }) => `
CREATE TABLE IF NOT EXISTS memory (
  id          TEXT PRIMARY KEY,
  content     TEXT NOT NULL,
  category    TEXT,
  target      TEXT,
  importance  ${t.real} NOT NULL DEFAULT 0.5,
  tags_json   TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  source      TEXT,
  author      TEXT
);
CREATE INDEX IF NOT EXISTS idx_memory_category ON memory(category);
CREATE INDEX IF NOT EXISTS idx_memory_importance ON memory(importance);

CREATE TABLE IF NOT EXISTS docs (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  tags_json   TEXT NOT NULL DEFAULT '[]',
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  scope       TEXT
);
CREATE INDEX IF NOT EXISTS idx_docs_scope ON docs(scope);
-- Slug is unique per scope, not globally: two projects may each have a README or overview doc.
-- COALESCE folds the null (scope-less) bucket so slugs stay unique within it too.
CREATE UNIQUE INDEX IF NOT EXISTS idx_docs_scope_slug ON docs((COALESCE(scope, '')), slug);

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
  vec          ${t.blob} NOT NULL,
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

CREATE TABLE IF NOT EXISTS pat (
  id          TEXT PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,
  sub         TEXT NOT NULL,
  name        TEXT,
  grants_json TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  expires_at  ${t.bigint},
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

const SQLITE_SCHEMA = `${COMMON_TABLES({ real: 'REAL', blob: 'BLOB', bigint: 'INTEGER' })}
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  at         TEXT NOT NULL,
  refs_json  TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);

-- BM25 indexes. The porter tokenizer stems (settlement/settlements); the old one did not.
-- Kept as plain mirrors rather than external-content tables so a rebuild is a delete + insert
-- and never depends on rowid alignment with the source table.
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  id UNINDEXED, scope UNINDEXED, body, tokenize = 'porter unicode61'
);
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
  id UNINDEXED, scope UNINDEXED, body, tokenize = 'porter unicode61'
);
-- Conversation history was previously selected by recency alone, so a question whose answer
-- was discussed twenty messages ago could not reach the context block at all.
CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
  id UNINDEXED, scope UNINDEXED, body, tokenize = 'porter unicode61'
);
`;

/** One full-text mirror table on Postgres: a stored tsvector (english = snowball stemming) under a GIN index. */
const pgFts = (table: string) => `
CREATE TABLE IF NOT EXISTS ${table} (
  id    TEXT PRIMARY KEY,
  scope TEXT,
  body  TEXT NOT NULL,
  tsv   tsvector GENERATED ALWAYS AS (to_tsvector('english', body)) STORED
);
CREATE INDEX IF NOT EXISTS idx_${table}_tsv ON ${table} USING GIN (tsv);
CREATE INDEX IF NOT EXISTS idx_${table}_scope ON ${table}(scope);
`;

const POSTGRES_SCHEMA = `${COMMON_TABLES({ real: 'DOUBLE PRECISION', blob: 'BYTEA', bigint: 'BIGINT' })}
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  at         TEXT NOT NULL,
  refs_json  TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
${pgFts('memory_fts')}${pgFts('chunk_fts')}${pgFts('message_fts')}`;

// ---------------------------------------------------------------------------------------
// Dialects
// ---------------------------------------------------------------------------------------

const SQLITE_DIALECT: Dialect = {
  jsonArrayHas: (column) => `EXISTS (SELECT 1 FROM json_each(${column}) WHERE json_each.value = ?)`,
  nullEq: (column) => `${column} IS ?`,
  // SQLite returns bm25() as a negative number where more negative is a better match.
  ftsSearch: (table, withScope) =>
    `SELECT id, -bm25(${table}) AS score FROM ${table} WHERE ${table} MATCH ?${withScope ? ' AND scope = ?' : ''} ORDER BY score DESC LIMIT ?`,
};

const POSTGRES_DIALECT: Dialect = {
  jsonArrayHas: (column) => `EXISTS (SELECT 1 FROM json_array_elements_text(${column}::json) AS t(v) WHERE t.v = ?)`,
  nullEq: (column) => `${column} IS NOT DISTINCT FROM ?`,
  // websearch_to_tsquery reads the same `"term" OR "term"` string FTS5 does: quoted phrases, OR.
  ftsSearch: (table, withScope) =>
    `SELECT id, ts_rank_cd(tsv, q) AS score FROM ${table}, websearch_to_tsquery('english', ?) AS q WHERE tsv @@ q${withScope ? ' AND scope = ?' : ''} ORDER BY score DESC LIMIT ?`,
};

// ---------------------------------------------------------------------------------------
// A promise lock: one holder at a time, in arrival order.
// ---------------------------------------------------------------------------------------

class Lock {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    return prev.then(fn).finally(release);
  }
}

// ---------------------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------------------

class SqliteStore implements Store {
  readonly dialect = 'sqlite' as const;
  readonly sql = SQLITE_DIALECT;
  readonly description: string;
  private readonly lock = new Lock();
  /** Set while a transaction's callback runs: its statements go straight through. */
  private readonly inTx = new AsyncLocalStorage<true>();

  constructor(private readonly db: DatabaseSync, path: string) {
    this.description = `sqlite:${path}`;
  }

  private direct<T>(fn: () => T): Promise<T> {
    // Statements inside a transaction run at once; anything else waits for an open transaction
    // (or the statement ahead of it) so an `await` mid-transaction cannot let a stray write in.
    if (this.inTx.getStore()) return Promise.resolve().then(fn);
    return this.lock.run(async () => fn());
  }

  all<T = Row>(sql: string, params: Param[] = []): Promise<T[]> {
    return this.direct(() => this.db.prepare(sql).all(...(params as never[])) as T[]);
  }

  get<T = Row>(sql: string, params: Param[] = []): Promise<T | undefined> {
    return this.direct(() => this.db.prepare(sql).get(...(params as never[])) as T | undefined);
  }

  run(sql: string, params: Param[] = []): Promise<RunResult> {
    return this.direct(() => ({ changes: Number(this.db.prepare(sql).run(...(params as never[])).changes) }));
  }

  exec(sql: string): Promise<void> {
    return this.direct(() => this.db.exec(sql));
  }

  tx<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inTx.getStore()) return fn(); // already inside one: join it
    return this.lock.run(async () => {
      this.db.exec('BEGIN');
      try {
        const result = await this.inTx.run(true, fn);
        this.db.exec('COMMIT');
        return result;
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    });
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

function openSqlite(path: string): Store {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  // Wait for a competing writer instead of throwing SQLITE_BUSY at once: WAL allows one writer,
  // and a second process (seed, CLI, operator) must not abort a write sequence midway.
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SQLITE_SCHEMA);
  return new SqliteStore(db, path);
}

// ---------------------------------------------------------------------------------------
// Columns added after a table first shipped
// ---------------------------------------------------------------------------------------

/**
 * Columns added to a table after the first release. `CREATE TABLE IF NOT EXISTS` does nothing
 * for a store that already has the table, so each addition is also a guarded `ALTER TABLE` run
 * on open. Both engines are checked through their catalogue rather than by trying the ALTER
 * and swallowing the error, so a real failure still surfaces.
 */
const ADDED_COLUMNS: { table: string; column: string; ddl: string }[] = [
  // 0.3.0: who wrote a memory entry (the principal's sub), for per-member threads.
  { table: 'memory', column: 'author', ddl: 'TEXT' },
];

async function hasColumn(store: Store, table: string, column: string, schema?: string): Promise<boolean> {
  if (store.dialect === 'sqlite') {
    const cols = await store.all<{ name: string }>(`PRAGMA table_info(${table})`);
    return cols.some((c) => c.name === column);
  }
  const row = await store.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ?',
    [schema ?? 'agentdox', table, column],
  );
  return Number(row?.n ?? 0) > 0;
}

/** Add `column` to `table` when the store predates it. Idempotent; safe to run on every open. */
export async function ensureColumn(store: Store, table: string, column: string, ddl: string, schema?: string): Promise<boolean> {
  if (await hasColumn(store, table, column, schema)) return false;
  // Postgres can be told not to race a second instance doing the same; SQLite has one writer.
  const ifMissing = store.dialect === 'postgres' ? 'IF NOT EXISTS ' : '';
  await store.exec(`ALTER TABLE ${table} ADD COLUMN ${ifMissing}${column} ${ddl}`);
  return true;
}

async function ensureAddedColumns(store: Store, schema?: string): Promise<void> {
  for (const c of ADDED_COLUMNS) await ensureColumn(store, c.table, c.column, c.ddl, schema);
}

// ---------------------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------------------

/** `?` placeholders become `$1..$n`; nothing in this codebase's SQL carries a literal `?`. */
function numberPlaceholders(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

/** pg serialises Buffer as BYTEA but would JSON-encode a bare Uint8Array. */
const pgParam = (p: Param): unknown =>
  p instanceof Uint8Array && !Buffer.isBuffer(p) ? Buffer.from(p.buffer, p.byteOffset, p.byteLength) : p;

/** A lock key for schema creation, so two instances starting together take turns. */
const SCHEMA_LOCK_KEY = 0x61676478; // "agdx"

class PostgresStore implements Store {
  readonly dialect = 'postgres' as const;
  readonly sql = POSTGRES_DIALECT;
  private readonly inTx = new AsyncLocalStorage<PoolClient>();

  constructor(
    private readonly pool: Pool,
    readonly description: string,
  ) {}

  private client(): Pool | PoolClient {
    return this.inTx.getStore() ?? this.pool;
  }

  async all<T = Row>(sql: string, params: Param[] = []): Promise<T[]> {
    const res = await this.client().query(numberPlaceholders(sql), params.map(pgParam));
    return res.rows as T[];
  }

  async get<T = Row>(sql: string, params: Param[] = []): Promise<T | undefined> {
    return (await this.all<T>(sql, params))[0];
  }

  async run(sql: string, params: Param[] = []): Promise<RunResult> {
    const res = await this.client().query(numberPlaceholders(sql), params.map(pgParam));
    return { changes: res.rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.client().query(sql);
  }

  async tx<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inTx.getStore()) return fn();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      try {
        const result = await this.inTx.run(client, fn);
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      }
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Postgres options; the schema keeps agentdox's tables apart from a host application's. */
export interface PostgresOptions {
  schema?: string;
}

async function openPostgres(url: string, opts: PostgresOptions = {}): Promise<Store> {
  const schema = opts.schema ?? 'agentdox';
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) throw new Error(`invalid Postgres schema name: ${schema}`);
  // COUNT(*) and BIGINT columns come back as strings by default; every such value here fits a
  // double (millisecond epochs, row counts), so read them as numbers like SQLite does.
  const getTypeParser = ((oid: number, format?: 'text' | 'binary') =>
    oid === 20 ? (v: string) => Number(v) : pgTypes.getTypeParser(oid as never, format as never)) as typeof pgTypes.getTypeParser;
  const pool = new Pool({ connectionString: url, types: { getTypeParser } });
  pool.on('connect', (client) => {
    void client.query(`SET search_path TO "${schema}", public`).catch(() => undefined);
  });
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await client.query(`SET search_path TO "${schema}", public`);
    await client.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK_KEY]);
    try {
      await client.query(POSTGRES_SCHEMA);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
  let where = 'server';
  try {
    const u = new URL(url);
    where = `${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`;
  } catch {
    /* the description is only for logs */
  }
  return new PostgresStore(pool, `postgres:${where} (schema ${schema})`);
}

// ---------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------

export const isPostgresUrl = (target: string): boolean => /^postgres(ql)?:\/\//i.test(target);

/**
 * Open a store: a `postgres://` URL (tables under `opts.schema`, default `agentdox`), or the
 * path of a SQLite file. Creates whatever schema is missing; both are safe to reopen.
 */
export async function openStore(target: string, opts: PostgresOptions = {}): Promise<Store> {
  const store = isPostgresUrl(target) ? await openPostgres(target, opts) : openSqlite(target);
  await ensureAddedColumns(store, isPostgresUrl(target) ? (opts.schema ?? 'agentdox') : undefined);
  return store;
}

/** @deprecated Use `openStore`, which is asynchronous and dialect-aware. */
export const openDatabase = (path: string): Promise<Store> => openStore(path);
