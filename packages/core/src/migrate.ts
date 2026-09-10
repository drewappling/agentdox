/**
 * Copy one store into another: SQLite → Postgres when a deployment grows to several instances,
 * or Postgres → SQLite to take a copy home. Every table is copied row for row, the retrieval
 * mirrors included, so the target is searchable the moment the copy ends and no vector has to
 * be recomputed.
 */
import type { Param, Row, Store } from './db.js';

/** Tables in dependency order, with the columns both engines share (no generated columns). */
const TABLES: { name: string; columns: string[] }[] = [
  { name: 'projects', columns: ['id', 'slug', 'name', 'description', 'owner_sub', 'created_at'] },
  { name: 'memory', columns: ['id', 'content', 'category', 'target', 'importance', 'tags_json', 'created_at', 'updated_at', 'source', 'author'] },
  { name: 'docs', columns: ['id', 'slug', 'title', 'content', 'tags_json', 'version', 'created_at', 'updated_at', 'scope'] },
  { name: 'doc_versions', columns: ['doc_id', 'version', 'content', 'updated_at'] },
  { name: 'doc_chunks', columns: ['id', 'doc_id', 'scope', 'slug', 'title', 'heading', 'ordinal', 'content', 'updated_at'] },
  { name: 'sessions', columns: ['id', 'scope', 'title', 'started_at', 'ended_at'] },
  { name: 'messages', columns: ['id', 'session_id', 'role', 'content', 'at', 'refs_json'] },
  { name: 'pat', columns: ['id', 'token_hash', 'sub', 'name', 'grants_json', 'created_at', 'expires_at', 'revoked'] },
  { name: 'context_snapshots', columns: ['id', 'scope', 'query', 'prompt', 'chars', 'memory_hits', 'docs_count', 'session_msgs', 'assembled_at'] },
  { name: 'context_briefs', columns: ['scope', 'brief_json', 'updated_at'] },
  { name: 'embeddings', columns: ['owner_kind', 'owner_id', 'scope', 'model', 'dims', 'content_hash', 'vec', 'updated_at'] },
  { name: 'memory_fts', columns: ['id', 'scope', 'body'] },
  { name: 'chunk_fts', columns: ['id', 'scope', 'body'] },
  { name: 'message_fts', columns: ['id', 'scope', 'body'] },
];

const BATCH = 200;

export interface CopyOptions {
  /** Empty the target first. Without it a target holding any row is refused. */
  replace?: boolean;
  /** Progress, one line per table. */
  log?: (line: string) => void;
}

export interface CopyReport {
  /** Rows copied per table. */
  tables: Record<string, number>;
  total: number;
}

/** Rows in the target across every table, to refuse a copy onto live data. */
export async function storeRowCount(store: Store): Promise<number> {
  let n = 0;
  for (const t of TABLES) n += Number((await store.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t.name}`))?.n ?? 0);
  return n;
}

/**
 * Copy every table from `from` into `to`. The target must be empty unless `replace` is set,
 * in which case it is emptied first (in one transaction with the copy, so a failure leaves
 * the target as it was). Ids are preserved, message ids included, so vectors and index rows
 * keyed by id stay valid.
 */
export async function copyStore(from: Store, to: Store, opts: CopyOptions = {}): Promise<CopyReport> {
  const log = opts.log ?? (() => undefined);
  const existing = await storeRowCount(to);
  if (existing > 0 && !opts.replace) throw new Error(`target ${to.description} holds ${existing} rows; pass replace to overwrite them`);

  const report: CopyReport = { tables: {}, total: 0 };
  await to.tx(async () => {
    if (existing > 0) {
      for (const t of [...TABLES].reverse()) await to.exec(`DELETE FROM ${t.name}`);
      log(`emptied ${to.description}`);
    }
    for (const t of TABLES) {
      const rows = await from.all<Row>(`SELECT ${t.columns.join(', ')} FROM ${t.name}`);
      const placeholders = `(${t.columns.map(() => '?').join(', ')})`;
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const params: Param[] = [];
        for (const row of batch) for (const c of t.columns) params.push(normalize(row[c]));
        await to.run(`INSERT INTO ${t.name} (${t.columns.join(', ')}) VALUES ${batch.map(() => placeholders).join(', ')}`, params);
      }
      report.tables[t.name] = rows.length;
      report.total += rows.length;
      log(`${t.name}: ${rows.length} row${rows.length === 1 ? '' : 's'}`);
    }
    // Message ids were copied verbatim; the identity column's counter has to move past them.
    if (to.dialect === 'postgres') {
      await to.exec(`SELECT setval(pg_get_serial_sequence('messages', 'id'), COALESCE((SELECT MAX(id) FROM messages), 0) + 1, false)`);
    }
  });
  return report;
}

/** Driver values into store parameters: bigints and Buffers travel as numbers and byte arrays. */
function normalize(v: unknown): Param {
  if (v === undefined || v === null) return null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return String(v);
}
