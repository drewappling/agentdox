import type { Doc, DocVersion } from '@agentdox/types';
import type { Param, Store } from './db.js';
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

const CHUNK_COLUMNS = 'id, doc_id, scope, slug, title, heading, ordinal, content';

const toChunk = (c: ChunkRow, score: number): ChunkHit => ({
  id: c.id,
  docId: c.doc_id,
  scope: c.scope ?? undefined,
  slug: c.slug,
  title: c.title,
  heading: c.heading,
  ordinal: Number(c.ordinal),
  content: c.content,
  score,
});

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
      version: Number(row.version),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      scope: row.scope ?? undefined,
    };
  }

  async create(input: { slug: string; title: string; content: string; tags?: string[]; scope?: string; id?: string }): Promise<Doc> {
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
    await this.store.tx(async () => {
      await this.store.run(
        `INSERT INTO docs (id, slug, title, content, tags_json, version, created_at, updated_at, scope)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [doc.id, doc.slug, doc.title, doc.content, JSON.stringify(doc.tags), doc.version, doc.createdAt, doc.updatedAt, doc.scope ?? null],
      );
      await this.store.run(`INSERT INTO doc_versions (doc_id, version, content, updated_at) VALUES (?, ?, ?, ?)`, [
        doc.id,
        doc.version,
        doc.content,
        doc.updatedAt,
      ]);
      await this.indexer?.indexDoc(doc);
    });
    return doc;
  }

  async get(id: string): Promise<Doc | null> {
    const row = await this.store.get<Row>('SELECT * FROM docs WHERE id = ?', [id]);
    return row ? this.toDoc(row) : null;
  }

  async getBySlug(slug: string, scope?: string): Promise<Doc | null> {
    const row =
      scope === undefined
        ? await this.store.get<Row>('SELECT * FROM docs WHERE slug = ? ORDER BY updated_at DESC LIMIT 1', [slug])
        : await this.store.get<Row>(`SELECT * FROM docs WHERE slug = ? AND ${this.store.sql.nullEq('scope')}`, [slug, scope]);
    return row ? this.toDoc(row) : null;
  }

  /** Save a new revision: bumps version and snapshots the previous content. */
  async update(id: string, patch: Partial<Pick<Doc, 'title' | 'content' | 'tags' | 'scope' | 'slug'>>): Promise<Doc | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    const next: Doc = {
      ...existing,
      ...patch,
      id,
      version: existing.version + 1,
      updatedAt: nowIso(),
      createdAt: existing.createdAt,
    };
    await this.store.tx(async () => {
      await this.store.run(
        `UPDATE docs SET slug = ?, title = ?, content = ?, tags_json = ?, version = ?, updated_at = ?, scope = ? WHERE id = ?`,
        [next.slug, next.title, next.content, JSON.stringify(next.tags), next.version, next.updatedAt, next.scope ?? null, next.id],
      );
      await this.store.run(`INSERT INTO doc_versions (doc_id, version, content, updated_at) VALUES (?, ?, ?, ?)`, [
        next.id,
        next.version,
        next.content,
        next.updatedAt,
      ]);
      await this.indexer?.indexDoc(next);
    });
    return this.get(id);
  }

  async remove(id: string): Promise<boolean> {
    await this.indexer?.removeDoc(id);
    const res = await this.store.run('DELETE FROM docs WHERE id = ?', [id]);
    return res.changes > 0;
  }

  async list(filter: DocFilter = {}): Promise<Doc[]> {
    const clauses: string[] = [];
    const args: Param[] = [];
    if (filter.scope) {
      clauses.push('scope = ?');
      args.push(filter.scope);
    }
    if (filter.tag) {
      clauses.push(this.store.sql.jsonArrayHas('tags_json'));
      args.push(filter.tag);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = filter.limit ?? 100;
    const rows = await this.store.all<Row>(`SELECT * FROM docs ${where} ORDER BY updated_at DESC LIMIT ?`, [...args, limit]);
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
    const lists = [await lexicalSearch(this.store, 'chunk_fts', query, { scope: filter.scope, limit: pool })];

    const provider = this.indexer?.embeddingProvider;
    if (provider) {
      try {
        const [queryVec] = await provider.embed([query], 'query');
        if (queryVec) {
          lists.push(
            await vectorSearch(this.store, 'chunk', queryVec, {
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

    const hits: ChunkHit[] = [];
    for (const row of fused.slice(0, limit)) {
      const c = await this.store.get<ChunkRow>(`SELECT ${CHUNK_COLUMNS} FROM doc_chunks WHERE id = ?`, [row.id]);
      if (!c) continue;
      hits.push(toChunk(c, row.score));
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
      const doc = await this.get(chunk.docId);
      if (doc) docs.push(doc);
      if (docs.length >= limit) break;
    }
    if (docs.length) return docs;
    return this.legacySearch(query, filter);
  }

  /** Pre-chunking scorer, retained for stores whose index has not been built yet. */
  private async legacySearch(query: string, filter: DocFilter = {}): Promise<Doc[]> {
    const rel = relevanceScore;
    return (await this.list({ ...filter, limit: 500 }))
      .map((doc) => ({ doc, score: rel(query, doc.title, doc.content, doc.slug, doc.tags.join(' ')) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, filter.limit ?? 10)
      .map((x) => x.doc);
  }

  /** Every chunk of one document, in reading order. */
  async chunksFor(docId: string): Promise<ChunkHit[]> {
    const rows = await this.store.all<ChunkRow>(`SELECT ${CHUNK_COLUMNS} FROM doc_chunks WHERE doc_id = ? ORDER BY ordinal`, [docId]);
    return rows.map((c) => toChunk(c, 0));
  }

  async history(id: string): Promise<DocVersion[]> {
    const rows = await this.store.all<{ version: number; content: string; updated_at: string }>(
      'SELECT version, content, updated_at FROM doc_versions WHERE doc_id = ? ORDER BY version DESC',
      [id],
    );
    return rows.map((r) => ({ version: Number(r.version), content: r.content, updatedAt: r.updated_at }));
  }
}
