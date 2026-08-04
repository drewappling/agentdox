import type { Doc, DocVersion } from '@agentdox/types';
import type { Store } from './db.js';
import { newId, nowIso, parseJsonArray, relevanceScore } from './util.js';

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
  constructor(private readonly store: Store) {}

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
    return this.get(id);
  }

  remove(id: string): boolean {
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

  search(query: string, filter: DocFilter = {}): Doc[] {
    const rel = relevanceScore;
    return this.list({ ...filter, limit: 500 })
      .map((doc) => ({ doc, score: rel(query, doc.title, doc.content, doc.slug, doc.tags.join(' ')) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, filter.limit ?? 10)
      .map((x) => x.doc);
  }

  history(id: string): DocVersion[] {
    const rows = this.store.db
      .prepare('SELECT version, content, updated_at FROM doc_versions WHERE doc_id = ? ORDER BY version DESC')
      .all(id) as { version: number; content: string; updated_at: string }[];
    return rows.map((r) => ({ version: r.version, content: r.content, updatedAt: r.updated_at }));
  }
}