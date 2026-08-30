import type { Doc, DocVersion } from '@agentdox/types';
import type { Store } from './db.js';
import { newId, nowIso, parseJsonArray, relevanceScore } from './util.js';
import type { IndexService } from './indexer.js';
import { fuseRRF, lexicalSearch, vectorSearch } from './retrieval.js';

/** A retrieved passage of a document, with enough breadcrumb to read on its own. */
export interface ChunkHit {
  id: string;
  docId: string;
  /** Owning scope of the parent document (undefined when the doc has no scope). */
  scope?: string;
  slug: string;
  title: string;
  /** Heading breadcrumb within the doc, e.g. "Roads > What is NOT done". */
  heading: string;
  ordinal: number;
  content: string;
  score: number;
}

type ChunkRow = {
  id: string;
  doc_id: string;
  scope: string | null;
  slug: string;
  title: string;
  heading: string;
  ordinal: number;
  content: string;
};

type Row = {
  id: string;
  slug: string;
  title: string;
  content: string;
  tags_json: string;
  version: number;
  created_at: string;
  updated_at: string;
  scope: string | null;
};

export interface DocFilter {
  scope?: string;
  tag?: string;
  limit?: number;
}

export class DocService {
  private indexer: IndexService | null = null;

  constructor(private readonly store: Store) {}

  /** Wired by `AgentDox`; without it docs are stored but not chunked or indexed. */
  setIndexer(indexer: IndexService): void {
    this.indexer = indexer;
  }

  toDoc(row: Row): Doc {
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      content: row.content,
      tags: parseJsonArray<string>(row.tags_json),
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      scope: row.scope ?? undefined,
    };
  }

  create(input: { slug: string; title: string; content: string; tags?: string[]; scope?: string; id?: string }): Doc {
    const now = nowIso();
    const doc: Doc = {
      id: input.id ?? newId('doc'),
      slug: input.slug,
      title: input.title,
      content: input.content,
      tags: input.tags ?? [],
      version: 1,
      createdAt: now,
      updatedAt: now,
      scope: input.scope,
    };
    this.store.db
      .prepare(
        `INSERT INTO docs (id, slug, title, content, tags_json, version, created_at, updated_at, scope)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        doc.id,
        doc.slug,
        doc.title,
        doc.content,
        JSON.stringify(doc.tags),
        doc.version,
        doc.createdAt,
        doc.updatedAt,
        doc.scope ?? null,
      );
    this.store.db
      .prepare(`INSERT INTO doc_versions (doc_id, version, content, updated_at) VALUES (?, ?, ?, ?)`)
      .run(doc.id, doc.version, doc.content, doc.updatedAt);
    this.indexer?.indexDoc(doc);
    return doc;
  }

  get(id: string): Doc | null {
    const row = this.store.db.prepare('SELECT * FROM docs WHERE id = ?').get(id) as Row | undefined;
    return row ? this.toDoc(row) : null;
  }

  getBySlug(slug: string): Doc | null {
    const row = this.store.db.prepare('SELECT * FROM docs WHERE slug = ?').get(slug) as Row | undefined;
    return row ? this.toDoc(row) : null;
  }

  /** Save a new revision: bumps version and snapshots the previous content. */
  update(id: string, patch: Partial<Pick<Doc, 'title' | 'content' | 'tags' | 'scope' | 'slug'>>): Doc | null {
    const existing = this.get(id);
    if (!existing) return null;
    const next: Doc = {
      ...existing,
      ...patch,
      id,
      version: existing.version + 1,
      updatedAt: nowIso(),
      createdAt: existing.createdAt,
    };
    this.store.db
      .prepare(
        `UPDATE docs SET slug = ?, title = ?, content = ?, tags_json = ?, version = ?, updated_at = ?, scope = ? WHERE id = ?`,
      )
      .run(
        next.slug,
        next.title,
        next.content,
        JSON.stringify(next.tags),
        next.version,
        next.updatedAt,
        next.scope ?? null,
        next.id,
      );
    this.store.db
      .prepare(`INSERT INTO doc_versions (doc_id, version, content, updated_at) VALUES (?, ?, ?, ?)`)
      .run(next.id, next.version, next.content, next.updatedAt);
    this.indexer?.indexDoc(next);
    return this.get(id);
  }

  remove(id: string): boolean {
    this.indexer?.removeDoc(id);
    const res = this.store.db.prepare('DELETE FROM docs WHERE id = ?').run(id);
    return res.changes > 0;
  }

  list(filter: DocFilter = {}): Doc[] {
    const clauses: string[] = [];
    const args: (string | number | null)[] = [];
    if (filter.scope) {
      clauses.push('scope = ?');
      args.push(filter.scope);
    }
    if (filter.tag) {
      clauses.push('EXISTS (SELECT 1 FROM json_each(tags_json) WHERE json_each.value = ?)');
      args.push(filter.tag);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = filter.limit ?? 100;
    const rows = this.store.db.prepare(`SELECT * FROM docs ${where} ORDER BY updated_at DESC LIMIT ?`).all(...args, limit) as Row[];
    return rows.map((r) => this.toDoc(r));
  }

  /**
   * Passage-level retrieval — the unit that measurably matters. Scoring whole documents let a
   * 44k-char doc win on term count and then contribute only its opening paragraphs; a chunk is
   * both better ranked and directly injectable.
   */
  async searchChunks(query: string, filter: DocFilter = {}): Promise<ChunkHit[]> {
    const limit = filter.limit ?? 10;
    const pool = limit * 4;
    const lists = [lexicalSearch(this.store.db, 'chunk_fts', query, { scope: filter.scope, limit: pool })];

    const provider = this.indexer?.embeddingProvider;
    if (provider) {
      try {
        const [queryVec] = await provider.embed([query], 'query');
        if (queryVec) {
          lists.push(
            vectorSearch(this.store.db, 'chunk', queryVec, {
              scope: filter.scope,
              limit: pool,
              model: provider.model,
            }),
          );
        }
      } catch {
        // Provider unreachable: lexical-only, as documented.
      }
    }

    const fused = fuseRRF(lists.filter((l) => l.length));
    if (!fused.length) return [];

    const byId = this.store.db.prepare(
      'SELECT id, doc_id, scope, slug, title, heading, ordinal, content FROM doc_chunks WHERE id = ?',
    );
    const hits: ChunkHit[] = [];
    for (const row of fused.slice(0, limit)) {
      const c = byId.get(row.id) as ChunkRow | undefined;
      if (!c) continue;
      hits.push({
        id: c.id,
        docId: c.doc_id,
        scope: c.scope ?? undefined,
        slug: c.slug,
        title: c.title,
        heading: c.heading,
        ordinal: c.ordinal,
        content: c.content,
        score: row.score,
      });
    }
    return hits;
  }

  /**
   * Document-level search, kept for callers that want whole docs. Ranked by the best chunk each
   * document contributed, so ordering inherits the chunk-level improvement.
   */
  async search(query: string, filter: DocFilter = {}): Promise<Doc[]> {
    const limit = filter.limit ?? 10;
    const chunks = await this.searchChunks(query, { ...filter, limit: limit * 3 });
    const seen = new Set<string>();
    const docs: Doc[] = [];
    for (const chunk of chunks) {
      if (seen.has(chunk.docId)) continue;
      seen.add(chunk.docId);
      const doc = this.get(chunk.docId);
      if (doc) docs.push(doc);
      if (docs.length >= limit) break;
    }
    if (docs.length) return docs;
    return this.legacySearch(query, filter);
  }

  /** Pre-chunking scorer, retained for stores whose index has not been built yet. */
  private legacySearch(query: string, filter: DocFilter = {}): Doc[] {
    const rel = relevanceScore;
    return this.list({ ...filter, limit: 500 })
      .map((doc) => ({ doc, score: rel(query, doc.title, doc.content, doc.slug, doc.tags.join(' ')) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, filter.limit ?? 10)
      .map((x) => x.doc);
  }

  /** Every chunk of one document, in reading order. */
  chunksFor(docId: string): ChunkHit[] {
    const rows = this.store.db
      .prepare('SELECT id, doc_id, scope, slug, title, heading, ordinal, content FROM doc_chunks WHERE doc_id = ? ORDER BY ordinal')
      .all(docId) as ChunkRow[];
    return rows.map((c) => ({
      id: c.id, docId: c.doc_id, scope: c.scope ?? undefined, slug: c.slug, title: c.title,
      heading: c.heading, ordinal: c.ordinal, content: c.content, score: 0,
    }));
  }

  history(id: string): DocVersion[] {
    const rows = this.store.db
      .prepare('SELECT version, content, updated_at FROM doc_versions WHERE doc_id = ? ORDER BY version DESC')
      .all(id) as { version: number; content: string; updated_at: string }[];
    return rows.map((r) => ({ version: r.version, content: r.content, updatedAt: r.updated_at }));
  }
}