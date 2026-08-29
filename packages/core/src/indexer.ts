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

export interface IndexStats {
  memory: { total: number; embedded: number };
  chunks: { total: number; embedded: number };
  provider: string | null;
  model: string | null;
}

const hash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 32);

/** How many texts go to the provider per request. Ollama is happy with this; so is OpenAI. */
const EMBED_BATCH = 32;

export class IndexService {
  constructor(
    private readonly store: Store,
    private provider: EmbeddingProvider | null = null,
  ) {}

  setProvider(provider: EmbeddingProvider | null): void {
    this.provider = provider;
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

  /** Rebuild every lexical index from the source tables. Safe to run at any time. */
  rebuildLexical(): { memory: number; chunks: number } {
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
    return { memory: mem.length, chunks };
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

    type Pending = { kind: 'memory' | 'chunk'; id: string; scope: string | null; text: string };
    const pending: Pending[] = [];

    const scopeSql = opts.scope ? 'AND m.category = ?' : '';
    const memArgs = opts.scope ? [provider.model, opts.scope] : [provider.model];
    const memRows = this.store.db
      .prepare(
        `SELECT m.id, m.category AS scope, m.content FROM memory m
         LEFT JOIN embeddings e ON e.owner_kind = 'memory' AND e.owner_id = m.id AND e.model = ?
         WHERE e.owner_id IS NULL ${scopeSql}`,
      )
      .all(...memArgs) as { id: string; scope: string | null; content: string }[];
    for (const r of memRows) pending.push({ kind: 'memory', id: r.id, scope: r.scope, text: r.content });

    const chunkScopeSql = opts.scope ? 'AND c.scope = ?' : '';
    const chunkArgs = opts.scope ? [provider.model, opts.scope] : [provider.model];
    const chunkRows = this.store.db
      .prepare(
        `SELECT c.id, c.scope, c.title, c.heading, c.content FROM doc_chunks c
         LEFT JOIN embeddings e ON e.owner_kind = 'chunk' AND e.owner_id = c.id AND e.model = ?
         WHERE e.owner_id IS NULL ${chunkScopeSql}`,
      )
      .all(...chunkArgs) as { id: string; scope: string | null; title: string; heading: string; content: string }[];
    for (const r of chunkRows) {
      pending.push({
        kind: 'chunk',
        id: r.id,
        scope: r.scope,
        text: [r.title, r.heading, r.content].filter(Boolean).join('\n'),
      });
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
      provider: this.provider?.id ?? null,
      model: this.provider?.model ?? null,
    };
  }
}
