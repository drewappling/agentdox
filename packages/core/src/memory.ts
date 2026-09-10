import type { MemoryEntry, MemoryHit } from '@agentdox/types';
import type { Param, Store } from './db.js';
import { newId, nowIso, parseJsonArray, relevanceScore } from './util.js';
import type { IndexService } from './indexer.js';
import { fuseRRF, lexicalSearch, vectorSearch } from './retrieval.js';

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
  author: string | null;
  hits: number;
  last_hit_at: string | null;
};

/**
 * Importance nudges relevance rather than competing with it. RRF scores sit around 1/60, so an
 * additive boost would swamp the ranking; a small multiplier lifts a high-importance entry past
 * near-neighbours without letting it outrank a genuinely better match.
 */
const IMPORTANCE_TILT = 0.05;

/** Importance is documented as 0..1; clamp so a stray value can't dominate ranking. */
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

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
  private indexer: IndexService | null = null;

  constructor(private readonly store: Store) {}

  /** Wired by `AgentDox`; without it the service still works, just without the new indexes. */
  setIndexer(indexer: IndexService): void {
    this.indexer = indexer;
  }

  toEntry(row: Row): MemoryEntry {
    return {
      id: row.id,
      content: row.content,
      category: row.category ?? undefined,
      target: row.target ?? undefined,
      importance: Number(row.importance),
      tags: parseJsonArray<string>(row.tags_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      source: row.source ?? undefined,
      author: row.author ?? undefined,
      // The driver may hand a BIGINT back as a string; a pre-0.4 row read through an old
      // SELECT has no value at all. Both land as a number.
      hits: Number(row.hits ?? 0),
      lastHitAt: row.last_hit_at ?? undefined,
    };
  }

  /** Hits start at zero and are counted by context assembly; a caller never sets them. */
  async create(input: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt' | 'hits' | 'lastHitAt'> & Partial<Pick<MemoryEntry, 'id'>>): Promise<MemoryEntry> {
    const now = nowIso();
    const entry: MemoryEntry = {
      id: input.id ?? newId('mem'),
      content: input.content,
      importance: clamp01(input.importance ?? 0.5),
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
      hits: 0,
      ...(input.category ? { category: input.category } : {}),
      ...(input.target ? { target: input.target } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.author ? { author: input.author } : {}),
    };
    await this.store.tx(async () => {
      await this.store.run(
        `INSERT INTO memory (id, content, category, target, importance, tags_json, created_at, updated_at, source, author)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.id,
          entry.content,
          entry.category ?? null,
          entry.target ?? null,
          entry.importance,
          JSON.stringify(entry.tags),
          entry.createdAt,
          entry.updatedAt,
          entry.source ?? null,
          entry.author ?? null,
        ],
      );
      await this.indexer?.indexMemory(entry);
    });
    return entry;
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const row = await this.store.get<Row>('SELECT * FROM memory WHERE id = ?', [id]);
    return row ? this.toEntry(row) : null;
  }

  /** Hits are not part of the patch: an edit is not a use, and the counter belongs to assembly. */
  async update(id: string, patch: Partial<Omit<MemoryEntry, 'id' | 'createdAt' | 'hits' | 'lastHitAt'>>): Promise<MemoryEntry | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    const next: MemoryEntry = {
      ...existing,
      ...patch,
      id,
      createdAt: existing.createdAt,
      updatedAt: nowIso(),
    };
    next.importance = clamp01(next.importance);
    await this.store.tx(async () => {
      await this.store.run(
        `UPDATE memory SET content = ?, category = ?, target = ?, importance = ?, tags_json = ?, updated_at = ?, source = ?, author = ?
         WHERE id = ?`,
        [
          next.content,
          next.category ?? null,
          next.target ?? null,
          next.importance,
          JSON.stringify(next.tags),
          next.updatedAt,
          next.source ?? null,
          next.author ?? null,
          next.id,
        ],
      );
      await this.indexer?.indexMemory(next);
    });
    return this.get(id);
  }

  /**
   * Write an entry exactly as given — id, timestamps, author, hits included — creating or
   * replacing the row, and index it. This is the import path: a copy of another store's entry
   * must keep its identity and its history, which `create` and `update` are built not to allow.
   */
  async upsert(entry: MemoryEntry): Promise<void> {
    await this.store.tx(async () => {
      await this.store.run(
        `INSERT INTO memory (id, content, category, target, importance, tags_json, created_at, updated_at, source, author, hits, last_hit_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           content = excluded.content, category = excluded.category, target = excluded.target,
           importance = excluded.importance, tags_json = excluded.tags_json, created_at = excluded.created_at,
           updated_at = excluded.updated_at, source = excluded.source, author = excluded.author,
           hits = excluded.hits, last_hit_at = excluded.last_hit_at`,
        [
          entry.id,
          entry.content,
          entry.category ?? null,
          entry.target ?? null,
          clamp01(Number(entry.importance)),
          JSON.stringify(entry.tags ?? []),
          entry.createdAt,
          entry.updatedAt,
          entry.source ?? null,
          entry.author ?? null,
          Number(entry.hits ?? 0),
          entry.lastHitAt ?? null,
        ],
      );
      await this.indexer?.indexMemory(entry);
    });
  }

  /**
   * Count one retrieval hit on each of `ids`, stamped `at`: one statement however many entries
   * a block rendered. Context assembly calls it after rendering; nothing else should.
   */
  async recordHits(ids: string[], at: string): Promise<void> {
    if (!ids.length) return;
    await this.store.run(`UPDATE memory SET hits = hits + 1, last_hit_at = ? WHERE id IN (${ids.map(() => '?').join(', ')})`, [at, ...ids]);
  }

  async remove(id: string): Promise<boolean> {
    const res = await this.store.run('DELETE FROM memory WHERE id = ?', [id]);
    if (res.changes > 0) await this.indexer?.removeMemory(id);
    return res.changes > 0;
  }

  async count(): Promise<number> {
    const row = await this.store.get<{ n: number }>('SELECT COUNT(*) AS n FROM memory');
    return Number(row?.n ?? 0);
  }

  async list(filter: MemoryFilter = {}): Promise<MemoryEntry[]> {
    const clauses: string[] = [];
    const args: Param[] = [];
    if (filter.category) {
      clauses.push('category = ?');
      args.push(filter.category);
    }
    if (filter.target) {
      clauses.push('target = ?');
      args.push(filter.target);
    }
    if (filter.tag) {
      clauses.push(this.store.sql.jsonArrayHas('tags_json'));
      args.push(filter.tag);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = filter.limit ?? 100;
    const rows = await this.store.all<Row>(`SELECT * FROM memory ${where} ORDER BY importance DESC, updated_at DESC LIMIT ?`, [...args, limit]);
    return rows.map((r) => this.toEntry(r));
  }

  /**
   * Hybrid search: full-text ranking fused with vector similarity, tilted by importance.
   *
   * Falls back to the original term-frequency scorer when the fused result is empty — an index
   * that has not been built yet, or a query that is entirely stopwords, should still return
   * something rather than nothing.
   */
  async search(query: string, opts: MemorySearchOptions = {}): Promise<MemoryHit[]> {
    const limit = opts.limit ?? 20;
    const boost = opts.importanceBoost ?? 1;
    const pool = limit * 4;

    const lists = [await lexicalSearch(this.store, 'memory_fts', query, { scope: opts.category, limit: pool })];

    const provider = this.indexer?.embeddingProvider;
    if (provider) {
      try {
        const [queryVec] = await provider.embed([query], 'query');
        if (queryVec) {
          lists.push(
            await vectorSearch(this.store, 'memory', queryVec, {
              scope: opts.category,
              limit: pool,
              model: provider.model,
            }),
          );
        }
      } catch {
        // Provider unreachable: lexical-only results, which is the documented degradation.
      }
    }

    const fused = fuseRRF(lists.filter((l) => l.length));
    if (!fused.length) return this.legacySearch(query, opts);

    const hits: MemoryHit[] = [];
    for (const row of fused) {
      const entry = await this.get(row.id);
      if (!entry) continue; // index drifted ahead of a delete
      if (opts.target && entry.target !== opts.target) continue;
      if (opts.tag && !entry.tags.includes(opts.tag)) continue;
      hits.push({ entry, score: row.score * (1 + entry.importance * boost * IMPORTANCE_TILT) });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  /** The pre-BM25 scorer, kept as a floor for un-indexed stores and degenerate queries. */
  private async legacySearch(query: string, opts: MemorySearchOptions): Promise<MemoryHit[]> {
    const boost = opts.importanceBoost ?? 1;
    const candidates = await this.list({ category: opts.category, target: opts.target, tag: opts.tag, limit: 500 });
    const scored: MemoryHit[] = candidates.map((entry) => {
      const rel = relevanceScore(query, entry.content, entry.category ?? '', entry.target ?? '', entry.tags.join(' '));
      const score = rel + entry.importance * boost * 0.1;
      return { entry, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, opts.limit ?? 20);
  }
}
