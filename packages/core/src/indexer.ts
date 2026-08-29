/**
 * Keeps the retrieval indexes in step with the source tables.
 *
 * Two speeds, on purpose:
 * - **Lexical is synchronous.** FTS rows are written inside the same call that writes the
 *   memory entry or doc, so a fact is searchable the instant it is stored. It is pure SQLite;
 *   nothing can be down.
 * - **Vectors are backfilled.** Embedding means calling a model server that may be stopped,
 *   slow, or unconfigured. Blocking `memory_add` on that would make the store's most important
 *   write path fail for a retrieval nicety. Missing vectors simply mean the vector arm
 *   contributes nothing for those rows.
 */
import { createHash } from 'node:crypto';
import type { Store } from './db.js';
import { chunkIndexText, chunkMarkdown } from './chunking.js';
import { newId, nowIso } from './util.js';
import { type EmbeddingProvider, vectorToBlob } from './embeddings.js';

export type { IndexStats } from '@agentdox/types';
import type { IndexStats } from '@agentdox/types';

const hash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 32);

/** How many texts go to the provider per request. Ollama is happy with this; so is OpenAI. */
const EMBED_BATCH = 32;

export class IndexService {
  constructor(
    private readonly store: Store,
    private provider: EmbeddingProvider | null = null,
  ) {}

  /** Cached result of the last embedding-provider reachability probe. */
  private lastProbe: { ok: boolean; ms: number; at: string } | null = null;

  setProvider(provider: EmbeddingProvider | null): void {
    this.provider = provider;
    this.lastProbe = null;
  }

  get embeddingProvider(): EmbeddingProvider | null {
    return this.provider;
  }

  // ---------- lexical (synchronous, on the write path) ----------

  indexMemory(entry: { id: string; content: string; category?: string; tags?: string[] }): void {
    const body = [entry.content, (entry.tags ?? []).join(' ')].filter(Boolean).join('\n');
    this.store.db.prepare('DELETE FROM memory_fts WHERE id = ?').run(entry.id);
    this.store.db
      .prepare('INSERT INTO memory_fts (id, scope, body) VALUES (?, ?, ?)')
      .run(entry.id, entry.category ?? null, body);
  }

  /** Index one conversation message. Messages are short turns, so they are never chunked. */
  indexMessage(msg: { id: number; scope: string; role: string; content: string }): void {
    const key = String(msg.id);
    this.store.db.prepare('DELETE FROM message_fts WHERE id = ?').run(key);
    this.store.db
      .prepare('INSERT INTO message_fts (id, scope, body) VALUES (?, ?, ?)')
      .run(key, msg.scope, msg.role + ': ' + msg.content);
  }

  /** Drop index rows for every message of a session (used when a session is deleted). */
  removeSessionMessages(sessionId: string): void {
    const ids = this.store.db
      .prepare('SELECT id FROM messages WHERE session_id = ?')
      .all(sessionId) as { id: number }[];
    const delFts = this.store.db.prepare('DELETE FROM message_fts WHERE id = ?');
    const delEmb = this.store.db.prepare("DELETE FROM embeddings WHERE owner_kind = 'message' AND owner_id = ?");
    for (const { id } of ids) {
      delFts.run(String(id));
      delEmb.run(String(id));
    }
  }

  removeMemory(id: string): void {
    this.store.db.prepare('DELETE FROM memory_fts WHERE id = ?').run(id);
    this.store.db.prepare("DELETE FROM embeddings WHERE owner_kind = 'memory' AND owner_id = ?").run(id);
  }

  /** Re-chunk a document and replace its chunk + FTS rows. Called on every doc write. */
  indexDoc(doc: { id: string; slug: string; title: string; content: string; scope?: string }): number {
    this.removeDoc(doc.id);
    const now = nowIso();
    const chunks = chunkMarkdown(doc.content);
    const insertChunk = this.store.db.prepare(
      `INSERT INTO doc_chunks (id, doc_id, scope, slug, title, heading, ordinal, content, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertFts = this.store.db.prepare('INSERT INTO chunk_fts (id, scope, body) VALUES (?, ?, ?)');
    for (const chunk of chunks) {
      const id = newId('chk');
      insertChunk.run(
        id,
        doc.id,
        doc.scope ?? null,
        doc.slug,
        doc.title,
        chunk.heading,
        chunk.ordinal,
        chunk.content,
        now,
      );
      insertFts.run(id, doc.scope ?? null, chunkIndexText(doc.title, chunk));
    }
    return chunks.length;
  }

  removeDoc(docId: string): void {
    const ids = this.store.db
      .prepare('SELECT id FROM doc_chunks WHERE doc_id = ?')
      .all(docId) as { id: string }[];
    const delFts = this.store.db.prepare('DELETE FROM chunk_fts WHERE id = ?');
    const delEmb = this.store.db.prepare("DELETE FROM embeddings WHERE owner_kind = 'chunk' AND owner_id = ?");
    for (const { id } of ids) {
      delFts.run(id);
      delEmb.run(id);
    }
    this.store.db.prepare('DELETE FROM doc_chunks WHERE doc_id = ?').run(docId);
  }

  /**
   * True when there is content the lexical index does not cover — an upgraded store whose
   * index tables were created empty, a restored backup, or rows inserted straight into SQLite.
   * Cheap enough (four COUNTs) to call on every open.
   */
  needsLexicalBuild(): boolean {
    const n = (sql: string): number => (this.store.db.prepare(sql).get() as { n: number }).n;
    if (n('SELECT COUNT(*) n FROM memory') > 0 && n('SELECT COUNT(*) n FROM memory_fts') === 0) return true;
    if (n('SELECT COUNT(*) n FROM docs') > 0 && n('SELECT COUNT(*) n FROM doc_chunks') === 0) return true;
    if (n('SELECT COUNT(*) n FROM messages') > 0 && n('SELECT COUNT(*) n FROM message_fts') === 0) return true;
    return false;
  }

  /** Rebuild every lexical index from the source tables. Safe to run at any time. */
  rebuildLexical(): { memory: number; chunks: number; messages: number } {
    this.store.db.exec('DELETE FROM memory_fts');
    const mem = this.store.db
      .prepare('SELECT id, content, category, tags_json FROM memory')
      .all() as { id: string; content: string; category: string | null; tags_json: string }[];
    for (const row of mem) {
      let tags: string[] = [];
      try {
        const parsed = JSON.parse(row.tags_json);
        if (Array.isArray(parsed)) tags = parsed as string[];
      } catch {
        /* malformed tags -> index the content alone */
      }
      this.indexMemory({ id: row.id, content: row.content, category: row.category ?? undefined, tags });
    }

    this.store.db.exec('DELETE FROM chunk_fts');
    this.store.db.exec('DELETE FROM doc_chunks');
    const docs = this.store.db
      .prepare('SELECT id, slug, title, content, scope FROM docs')
      .all() as { id: string; slug: string; title: string; content: string; scope: string | null }[];
    let chunks = 0;
    for (const doc of docs) {
      chunks += this.indexDoc({ ...doc, scope: doc.scope ?? undefined });
    }

    this.store.db.exec('DELETE FROM message_fts');
    const msgs = this.store.db
      .prepare('SELECT m.id, m.role, m.content, s.scope FROM messages m JOIN sessions s ON s.id = m.session_id')
      .all() as { id: number; role: string; content: string; scope: string }[];
    for (const m of msgs) this.indexMessage(m);

    // A rebuild drops doc_chunks wholesale, which orphans the vectors keyed to the old chunk
    // ids — they are never matched again but still counted, and still scanned on every query.
    this.pruneOrphanVectors();

    return { memory: mem.length, chunks, messages: msgs.length };
  }

  // ---------- vectors (asynchronous, off the write path) ----------

  /**
   * Embed everything that has no current vector. Returns how many were written; a provider
   * failure stops the run and reports what it managed, rather than throwing at the caller.
   */
  async backfillEmbeddings(opts: { scope?: string; limit?: number } = {}): Promise<{
    embedded: number;
    pending: number;
    error?: string;
  }> {
    const provider = this.provider;
    if (!provider) return { embedded: 0, pending: 0 };

    type Pending = { kind: 'memory' | 'chunk' | 'message'; id: string; scope: string | null; text: string };
    const pending: Pending[] = [];

    // Rows with no vector for the active model, OR whose text changed since it was embedded.
    // The hash comparison is the point: `memory_update` is a mandated part of the write protocol,
    // and without it an edited entry keeps a vector describing text that no longer exists. Doc
    // chunks get fresh ids on every doc write so they cannot go stale, but the same check costs
    // nothing and covers a chunk written by any other path.
    const stale = (currentText: string, storedHash: string | null): boolean =>
      storedHash === null || storedHash !== hash(currentText);

    const scopeSql = opts.scope ? 'AND m.category = ?' : '';
    const memArgs = opts.scope ? [provider.model, opts.scope] : [provider.model];
    const memRows = this.store.db
      .prepare(
        `SELECT m.id, m.category AS scope, m.content, e.content_hash FROM memory m
         LEFT JOIN embeddings e ON e.owner_kind = 'memory' AND e.owner_id = m.id AND e.model = ?
         WHERE 1 = 1 ${scopeSql}`,
      )
      .all(...memArgs) as { id: string; scope: string | null; content: string; content_hash: string | null }[];
    for (const r of memRows) {
      if (stale(r.content, r.content_hash)) {
        pending.push({ kind: 'memory', id: r.id, scope: r.scope, text: r.content });
      }
    }

    const chunkScopeSql = opts.scope ? 'AND c.scope = ?' : '';
    const chunkArgs = opts.scope ? [provider.model, opts.scope] : [provider.model];
    const chunkRows = this.store.db
      .prepare(
        `SELECT c.id, c.scope, c.title, c.heading, c.content, e.content_hash FROM doc_chunks c
         LEFT JOIN embeddings e ON e.owner_kind = 'chunk' AND e.owner_id = c.id AND e.model = ?
         WHERE 1 = 1 ${chunkScopeSql}`,
      )
      .all(...chunkArgs) as {
        id: string;
        scope: string | null;
        title: string;
        heading: string;
        content: string;
        content_hash: string | null;
      }[];
    for (const r of chunkRows) {
      const text = [r.title, r.heading, r.content].filter(Boolean).join('\n');
      if (stale(text, r.content_hash)) {
        pending.push({ kind: 'chunk', id: r.id, scope: r.scope, text });
      }
    }


    const msgScopeSql = opts.scope ? 'AND s.scope = ?' : '';
    const msgArgs = opts.scope ? [provider.model, opts.scope] : [provider.model];
    const msgRows = this.store.db
      .prepare(
        `SELECT m.id, m.role, m.content, s.scope, e.content_hash FROM messages m
         JOIN sessions s ON s.id = m.session_id
         LEFT JOIN embeddings e ON e.owner_kind = 'message' AND e.owner_id = CAST(m.id AS TEXT) AND e.model = ?
         WHERE 1 = 1 ${msgScopeSql}`,
      )
      .all(...msgArgs) as { id: number; role: string; content: string; scope: string; content_hash: string | null }[];
    for (const r of msgRows) {
      const text = r.role + ': ' + r.content;
      if (stale(text, r.content_hash)) {
        pending.push({ kind: 'message', id: String(r.id), scope: r.scope, text });
      }
    }

    const budget = opts.limit ?? pending.length;
    const work = pending.slice(0, budget);
    const insert = this.store.db.prepare(
      `INSERT INTO embeddings (owner_kind, owner_id, scope, model, dims, content_hash, vec, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_kind, owner_id) DO UPDATE SET
         scope = excluded.scope, model = excluded.model, dims = excluded.dims,
         content_hash = excluded.content_hash, vec = excluded.vec, updated_at = excluded.updated_at`,
    );

    let embedded = 0;
    for (let i = 0; i < work.length; i += EMBED_BATCH) {
      const batch = work.slice(i, i + EMBED_BATCH);
      let vectors: Float32Array[];
      try {
        vectors = await provider.embed(batch.map((b) => b.text));
      } catch (e) {
        return { embedded, pending: pending.length - embedded, error: (e as Error).message };
      }
      const now = nowIso();
      for (let j = 0; j < batch.length; j++) {
        const item = batch[j];
        const vec = vectors[j];
        if (!item || !vec) continue;
        insert.run(
          item.kind,
          item.id,
          item.scope,
          provider.model,
          vec.length,
          hash(item.text),
          vectorToBlob(vec),
          now,
        );
        embedded++;
      }
    }
    return { embedded, pending: pending.length - embedded };
  }

  /**
   * Delete vectors whose owner row is gone. Chunk ids are regenerated on every doc write and on
   * every rebuild, so without this the embeddings table grows without bound and reports more
   * vectors than there are things to embed.
   */
  pruneOrphanVectors(): number {
    const res = this.store.db.prepare(
      `DELETE FROM embeddings WHERE
         (owner_kind = 'chunk'   AND owner_id NOT IN (SELECT id FROM doc_chunks)) OR
         (owner_kind = 'memory'  AND owner_id NOT IN (SELECT id FROM memory)) OR
         (owner_kind = 'message' AND owner_id NOT IN (SELECT CAST(id AS TEXT) FROM messages))`,
    ).run();
    return Number(res.changes);
  }

  /** Drop vectors that no longer match the active model, so a model swap re-embeds cleanly. */
  pruneStaleVectors(): number {
    if (!this.provider) return 0;
    const res = this.store.db.prepare('DELETE FROM embeddings WHERE model != ?').run(this.provider.model);
    return Number(res.changes);
  }

  stats(scope?: string): IndexStats {
    const one = (sql: string, args: (string | null)[] = []): number =>
      (this.store.db.prepare(sql).get(...args) as { n: number }).n;
    const memWhere = scope ? 'WHERE category = ?' : '';
    const chunkWhere = scope ? 'WHERE scope = ?' : '';
    const embWhere = (kind: string) =>
      scope ? `WHERE owner_kind = '${kind}' AND scope = ?` : `WHERE owner_kind = '${kind}'`;
    const a = scope ? [scope] : [];
    return {
      memory: {
        total: one(`SELECT COUNT(*) n FROM memory ${memWhere}`, a),
        embedded: one(`SELECT COUNT(*) n FROM embeddings ${embWhere('memory')}`, a),
      },
      chunks: {
        total: one(`SELECT COUNT(*) n FROM doc_chunks ${chunkWhere}`, a),
        embedded: one(`SELECT COUNT(*) n FROM embeddings ${embWhere('chunk')}`, a),
      },
      messages: {
        total: one(
          'SELECT COUNT(*) n FROM messages m JOIN sessions s ON s.id = m.session_id ' + (scope ? 'WHERE s.scope = ?' : ''),
          a,
        ),
        embedded: one(`SELECT COUNT(*) n FROM embeddings ${embWhere('message')}`, a),
      },
      provider: this.provider?.id ?? null,
      model: this.provider?.model ?? null,
      providerReachable: this.provider ? this.lastProbe?.ok ?? null : null,
      providerCheckedAt: this.lastProbe?.at ?? null,
    };
  }

  /**
   * Probe the embedding provider, cached briefly so a stats call cannot become a request storm.
   * Surfaced by /index/stats: a stopped model server should be visible, not just quietly
   * absent from every ranking.
   */
  async checkProvider(maxAgeMs = 30_000): Promise<boolean | null> {
    if (!this.provider) return null;
    const now = Date.now();
    if (this.lastProbe && now - this.lastProbe.ms < maxAgeMs) return this.lastProbe.ok;
    let ok = false;
    try {
      const [v] = await this.provider.embed(['ping'], 'query');
      ok = !!v?.length;
    } catch {
      ok = false;
    }
    this.lastProbe = { ok, ms: now, at: new Date(now).toISOString() };
    return ok;
  }
}
