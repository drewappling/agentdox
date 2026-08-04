import type { MemoryEntry, MemoryHit } from '@agentdox/types';
import type { Store } from './db.js';
import { newId, nowIso, parseJsonArray, relevanceScore } from './util.js';

type Row = {
  id: string;
  content: string;
  category: string | null;
  target: string | null;
  importance: number;
  tags_json: string;
  created_at: string;
  updated_at: string;
  source: string | null;
  embedding_json?: string | null;
};

export interface MemoryFilter {
  category?: string;
  target?: string;
  tag?: string;
  limit?: number;
}

export interface MemorySearchOptions extends MemoryFilter {
  /** Boost so that high-importance entries surface even on weak matches. */
  importanceBoost?: number;
}

export class MemoryService {
  constructor(private readonly store: Store) {}

  toEntry(row: Row): MemoryEntry {
    return {
      id: row.id,
      content: row.content,
      category: row.category ?? undefined,
      target: row.target ?? undefined,
      importance: row.importance,
      tags: parseJsonArray<string>(row.tags_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      source: row.source ?? undefined,
    };
  }

  create(input: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'> & Partial<Pick<MemoryEntry, 'id'>>): MemoryEntry {
    const now = nowIso();
    const entry: MemoryEntry = {
      id: input.id ?? newId('mem'),
      content: input.content,
      importance: input.importance ?? 0.5,
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
      ...(input.category ? { category: input.category } : {}),
      ...(input.target ? { target: input.target } : {}),
      ...(input.source ? { source: input.source } : {}),
    };
    this.store.db
      .prepare(
        `INSERT INTO memory (id, content, category, target, importance, tags_json, created_at, updated_at, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.content,
        entry.category ?? null,
        entry.target ?? null,
        entry.importance,
        JSON.stringify(entry.tags),
        entry.createdAt,
        entry.updatedAt,
        entry.source ?? null,
      );
    return entry;
  }

  get(id: string): MemoryEntry | null {
    const row = this.store.db.prepare('SELECT * FROM memory WHERE id = ?').get(id) as Row | undefined;
    return row ? this.toEntry(row) : null;
  }

  update(id: string, patch: Partial<Omit<MemoryEntry, 'id' | 'createdAt'>>): MemoryEntry | null {
    const existing = this.get(id);
    if (!existing) return null;
    const next: MemoryEntry = {
      ...existing,
      ...patch,
      id,
      createdAt: existing.createdAt,
      updatedAt: nowIso(),
    };
    this.store.db
      .prepare(
        `UPDATE memory SET content = ?, category = ?, target = ?, importance = ?, tags_json = ?, updated_at = ?, source = ?
         WHERE id = ?`,
      )
      .run(
        next.content,
        next.category ?? null,
        next.target ?? null,
        next.importance,
        JSON.stringify(next.tags),
        next.updatedAt,
        next.source ?? null,
        next.id,
      );
    return this.get(id);
  }

  remove(id: string): boolean {
    const res = this.store.db.prepare('DELETE FROM memory WHERE id = ?').run(id);
    return res.changes > 0;
  }

  count(): number {
    const row = this.store.db.prepare('SELECT COUNT(*) AS n FROM memory').get() as { n: number };
    return row.n;
  }

  list(filter: MemoryFilter = {}): MemoryEntry[] {
    const clauses: string[] = [];
    const args: (string | number | null)[] = [];
    if (filter.category) {
      clauses.push('category = ?');
      args.push(filter.category);
    }
    if (filter.target) {
      clauses.push('target = ?');
      args.push(filter.target);
    }
    if (filter.tag) {
      clauses.push("EXISTS (SELECT 1 FROM json_each(tags_json) WHERE json_each.value = ?)");
      args.push(filter.tag);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = filter.limit ?? 100;
    const rows = this.store.db
      .prepare(`SELECT * FROM memory ${where} ORDER BY importance DESC, updated_at DESC LIMIT ?`)
      .all(...args, limit) as Row[];
    return rows.map((r) => this.toEntry(r));
  }

  search(query: string, opts: MemorySearchOptions = {}): MemoryHit[] {
    const boost = opts.importanceBoost ?? 1;
    const candidates = this.list({ category: opts.category, target: opts.target, tag: opts.tag, limit: 500 });
    const scored: MemoryHit[] = candidates.map((entry) => {
      const rel = relevanceScore(query, entry.content, entry.category ?? '', entry.target ?? '', entry.tags.join(' '));
      // Composite: relevance dominates, importance nudges ties.
      const score = rel + entry.importance * boost * 0.1;
      return { entry, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, opts.limit ?? 20);
  }
}