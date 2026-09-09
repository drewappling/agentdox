/**
 * Keeps the retrieval indexes in step with the source tables.
 *
 * Two speeds, on purpose:
 * - **Lexical is on the write path.** Index rows are written inside the same transaction that
 *   writes the memory entry or doc, so a fact is searchable the instant it is stored. It is
 *   pure database work; nothing can be down.
 * - **Vectors are backfilled.** Embedding means calling a model server that may be stopped,
 *   slow, or unconfigured. Blocking `memory_add` on that would make the store's most important
 *   write path fail for a retrieval nicety. Missing vectors simply mean the vector arm
 *   contributes nothing for those rows.
 */
import { createHash } from 'node:crypto';
import type { Param, Store } from './db.js';
import { chunkIndexText, chunkMarkdown } from './chunking.js';
import { newId, nowIso } from './util.js';
import { type EmbeddingProvider, vectorToBlob } from './embeddings.js';

export type { IndexStats } from '@agentdox/types';
import type { IndexStats } from '@agentdox/types';

const hash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 32);

/** How many texts go to the provider per request. Ollama is happy with this; so is OpenAI. */
const EMBED_BATCH = 32;

/** Postgres advisory lock so two instances never rebuild the index at the same time. */
const REBUILD_LOCK_KEY = 0x61676479; // "agdy"

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

  // ---------- lexical (on the write path) ----------

  async indexMemory(entry: { id: string; content: string; category?: string; tags?: string[] }): Promise<void> {
    const body = [entry.content, (entry.tags ?? []).join(' ')].filter(Boolean).join('\n');
    await this.store.run('DELETE FROM memory_fts WHERE id = ?', [entry.id]);
    await this.store.run('INSERT INTO memory_fts (id, scope, body) VALUES (?, ?, ?)', [entry.id, entry.category ?? null, body]);
  }

  /** Index one conversation message. Messages are short turns, so they are never chunked. */
  async indexMessage(msg: { id: number; scope: string; role: string; content: string }): Promise<void> {
    const key = String(msg.id);
    await this.store.run('DELETE FROM message_fts WHERE id = ?', [key]);
    await this.store.run('INSERT INTO message_fts (id, scope, body) VALUES (?, ?, ?)', [key, msg.scope, msg.role + ': ' + msg.content]);
  }

  /** Drop index rows for every message of a session (used when a session is deleted). */
  async removeSessionMessages(sessionId: string): Promise<void> {
    const ids = await this.store.all<{ id: number }>('SELECT id FROM messages WHERE session_id = ?', [sessionId]);
    for (const { id } of ids) {
      await this.store.run('DELETE FROM message_fts WHERE id = ?', [String(id)]);
      await this.store.run("DELETE FROM embeddings WHERE owner_kind = 'message' AND owner_id = ?", [String(id)]);
    }
  }

  async removeMemory(id: string): Promise<void> {
    await this.store.run('DELETE FROM memory_fts WHERE id = ?', [id]);
    await this.store.run("DELETE FROM embeddings WHERE owner_kind = 'memory' AND owner_id = ?", [id]);
  }

  /** Re-chunk a document and replace its chunk + FTS rows. Called on every doc write. */
  async indexDoc(doc: { id: string; slug: string; title: string; content: string; scope?: string }): Promise<number> {
    await this.removeDoc(doc.id);
    const now = nowIso();
    const chunks = chunkMarkdown(doc.content);
    for (const chunk of chunks) {
      const id = newId('chk');
      await this.store.run(
        `INSERT INTO doc_chunks (id, doc_id, scope, slug, title, heading, ordinal, content, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, doc.id, doc.scope ?? null, doc.slug, doc.title, chunk.heading, chunk.ordinal, chunk.content, now],
      );
      await this.store.run('INSERT INTO chunk_fts (id, scope, body) VALUES (?, ?, ?)', [id, doc.scope ?? null, chunkIndexText(doc.title, chunk)]);
    }
    return chunks.length;
  }

  async removeDoc(docId: string): Promise<void> {
    const ids = await this.store.all<{ id: string }>('SELECT id FROM doc_chunks WHERE doc_id = ?', [docId]);
    for (const { id } of ids) {
      await this.store.run('DELETE FROM chunk_fts WHERE id = ?', [id]);
      await this.store.run("DELETE FROM embeddings WHERE owner_kind = 'chunk' AND owner_id = ?", [id]);
    }
    await this.store.run('DELETE FROM doc_chunks WHERE doc_id = ?', [docId]);
  }

  private async count(sql: string, args: Param[] = []): Promise<number> {
    return Number((await this.store.get<{ n: number }>(sql, args))?.n ?? 0);
  }

  /**
   * True when there is content the lexical index does not cover — an upgraded store whose
   * index tables were created empty, a restored backup, or rows inserted straight into the
   * database. Cheap enough (six COUNTs) to call on every open.
   */
  async needsLexicalBuild(): Promise<boolean> {
    const n = (sql: string) => this.count(sql);
    if ((await n('SELECT COUNT(*) n FROM memory')) > 0 && (await n('SELECT COUNT(*) n FROM memory_fts')) === 0) return true;
    if ((await n('SELECT COUNT(*) n FROM docs')) > 0 && (await n('SELECT COUNT(*) n FROM doc_chunks')) === 0) return true;
    if ((await n('SELECT COUNT(*) n FROM messages')) > 0 && (await n('SELECT COUNT(*) n FROM message_fts')) === 0) return true;
    return false;
  }

  /** Rebuild every lexical index from the source tables. Safe to run at any time. */
  async rebuildLexical(): Promise<{ memory: number; chunks: number; messages: number }> {
    return this.store.tx(async () => {
      // Several instances share a Postgres store; two rebuilds at once would race on the index
      // tables' primary keys. The lock is released with the transaction.
      if (this.store.dialect === 'postgres') await this.store.run('SELECT pg_advisory_xact_lock(?)', [REBUILD_LOCK_KEY]);

      await this.store.exec('DELETE FROM memory_fts');
      const mem = await this.store.all<{ id: string; content: string; category: string | null; tags_json: string }>(
        'SELECT id, content, category, tags_json FROM memory',
      );
      for (const row of mem) {
        let tags: string[] = [];
        try {
          const parsed = JSON.parse(row.tags_json);
          if (Array.isArray(parsed)) tags = parsed as string[];
        } catch {
          /* malformed tags -> index the content alone */
        }
        await this.indexMemory({ id: row.id, content: row.content, category: row.category ?? undefined, tags });
      }

      await this.store.exec('DELETE FROM chunk_fts');
      await this.store.exec('DELETE FROM doc_chunks');
      const docs = await this.store.all<{ id: string; slug: string; title: string; content: string; scope: string | null }>(
        'SELECT id, slug, title, content, scope FROM docs',
      );
      let chunks = 0;
      for (const doc of docs) {
        chunks += await this.indexDoc({ ...doc, scope: doc.scope ?? undefined });
      }

      await this.store.exec('DELETE FROM message_fts');
      const msgs = await this.store.all<{ id: number; role: string; content: string; scope: string }>(
        'SELECT m.id, m.role, m.content, s.scope FROM messages m JOIN sessions s ON s.id = m.session_id',
      );
      for (const m of msgs) await this.indexMessage({ ...m, id: Number(m.id) });

      // A rebuild drops doc_chunks wholesale, which orphans the vectors keyed to the old chunk
      // ids — they are never matched again but still counted, and still scanned on every query.
      await this.pruneOrphanVectors();

      return { memory: mem.length, chunks, messages: msgs.length };
    });
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
    // Reclaim vectors whose owner row is gone before scanning; the backfill runs continuously,
    // so without this it never cleans up orphans left by a delete that bypassed a remove() path.
    await this.pruneOrphanVectors();

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
    const memArgs: Param[] = opts.scope ? [provider.model, opts.scope] : [provider.model];
    const memRows = await this.store.all<{ id: string; scope: string | null; content: string; content_hash: string | null; emb_scope: string | null }>(
      `SELECT m.id, m.category AS scope, m.content, e.content_hash, e.scope AS emb_scope FROM memory m
       LEFT JOIN embeddings e ON e.owner_kind = 'memory' AND e.owner_id = m.id AND e.model = ?
       WHERE 1 = 1 ${scopeSql}`,
      memArgs,
    );
    for (const r of memRows) {
      // Re-embed when the text changed OR the entry moved to another scope (a category patch):
      // the vector's `scope` column must follow, or it stays searchable under the old scope and
      // invisible under the new one — a cross-scope leak, since category == the tenancy boundary.
      const scopeMoved = r.content_hash !== null && r.emb_scope !== r.scope;
      if (scopeMoved || stale(r.content, r.content_hash)) {
        pending.push({ kind: 'memory', id: r.id, scope: r.scope, text: r.content });
      }
    }

    const chunkScopeSql = opts.scope ? 'AND c.scope = ?' : '';
    const chunkArgs: Param[] = opts.scope ? [provider.model, opts.scope] : [provider.model];
    const chunkRows = await this.store.all<{ id: string; scope: string | null; title: string; heading: string; content: string; content_hash: string | null }>(
      `SELECT c.id, c.scope, c.title, c.heading, c.content, e.content_hash FROM doc_chunks c
       LEFT JOIN embeddings e ON e.owner_kind = 'chunk' AND e.owner_id = c.id AND e.model = ?
       WHERE 1 = 1 ${chunkScopeSql}`,
      chunkArgs,
    );
    for (const r of chunkRows) {
      const text = [r.title, r.heading, r.content].filter(Boolean).join('\n');
      if (stale(text, r.content_hash)) {
        pending.push({ kind: 'chunk', id: r.id, scope: r.scope, text });
      }
    }

    const msgScopeSql = opts.scope ? 'AND s.scope = ?' : '';
    const msgArgs: Param[] = opts.scope ? [provider.model, opts.scope] : [provider.model];
    const msgRows = await this.store.all<{ id: number; role: string; content: string; scope: string; content_hash: string | null }>(
      `SELECT m.id, m.role, m.content, s.scope, e.content_hash FROM messages m
       JOIN sessions s ON s.id = m.session_id
       LEFT JOIN embeddings e ON e.owner_kind = 'message' AND e.owner_id = CAST(m.id AS TEXT) AND e.model = ?
       WHERE 1 = 1 ${msgScopeSql}`,
      msgArgs,
    );
    for (const r of msgRows) {
      const text = r.role + ': ' + r.content;
      if (stale(text, r.content_hash)) {
        pending.push({ kind: 'message', id: String(r.id), scope: r.scope, text });
      }
    }

    const budget = opts.limit ?? pending.length;
    const work = pending.slice(0, budget);
    const upsert = `INSERT INTO embeddings (owner_kind, owner_id, scope, model, dims, content_hash, vec, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_kind, owner_id) DO UPDATE SET
         scope = excluded.scope, model = excluded.model, dims = excluded.dims,
         content_hash = excluded.content_hash, vec = excluded.vec, updated_at = excluded.updated_at`;

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
        await this.store.run(upsert, [item.kind, item.id, item.scope, provider.model, vec.length, hash(item.text), vectorToBlob(vec), now]);
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
  async pruneOrphanVectors(): Promise<number> {
    const res = await this.store.run(
      `DELETE FROM embeddings WHERE
         (owner_kind = 'chunk'   AND owner_id NOT IN (SELECT id FROM doc_chunks)) OR
         (owner_kind = 'memory'  AND owner_id NOT IN (SELECT id FROM memory)) OR
         (owner_kind = 'message' AND owner_id NOT IN (SELECT CAST(id AS TEXT) FROM messages))`,
    );
    return res.changes;
  }

  /** Drop vectors that no longer match the active model, so a model swap re-embeds cleanly. */
  async pruneStaleVectors(): Promise<number> {
    if (!this.provider) return 0;
    const res = await this.store.run('DELETE FROM embeddings WHERE model != ?', [this.provider.model]);
    return res.changes;
  }

  async stats(scope?: string): Promise<IndexStats> {
    const memWhere = scope ? 'WHERE category = ?' : '';
    const chunkWhere = scope ? 'WHERE scope = ?' : '';
    const embWhere = (kind: string) => (scope ? `WHERE owner_kind = '${kind}' AND scope = ?` : `WHERE owner_kind = '${kind}'`);
    const a: Param[] = scope ? [scope] : [];
    return {
      memory: {
        total: await this.count(`SELECT COUNT(*) n FROM memory ${memWhere}`, a),
        embedded: await this.count(`SELECT COUNT(*) n FROM embeddings ${embWhere('memory')}`, a),
      },
      chunks: {
        total: await this.count(`SELECT COUNT(*) n FROM doc_chunks ${chunkWhere}`, a),
        embedded: await this.count(`SELECT COUNT(*) n FROM embeddings ${embWhere('chunk')}`, a),
      },
      messages: {
        total: await this.count(
          'SELECT COUNT(*) n FROM messages m JOIN sessions s ON s.id = m.session_id ' + (scope ? 'WHERE s.scope = ?' : ''),
          a,
        ),
        embedded: await this.count(`SELECT COUNT(*) n FROM embeddings ${embWhere('message')}`, a),
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
