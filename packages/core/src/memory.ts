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
    };
  }

  async create(input: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'> & Partial<Pick<MemoryEntry, 'id'>>): Promise<MemoryEntry> {
    const now = nowIso();
    const entry: MemoryEntry = {
      id: input.id ?? newId('mem'),
      content: input.content,
      importance: clamp01(input.importance ?? 0.5),
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
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

  async update(id: string, patch: Partial<Omit<MemoryEntry, 'id' | 'createdAt'>>): Promise<MemoryEntry | null> {
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
