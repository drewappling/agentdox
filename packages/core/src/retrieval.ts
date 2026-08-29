/**
 * Hybrid retrieval: BM25 over FTS5, cosine over stored vectors, fused with reciprocal rank.
 *
 * Why this shape (measured in docs/architecture/rag.md):
 * - The old scorer was raw term frequency with no IDF or length normalisation, giving
 *   r(length, score) = 0.423 — the longest entry in a scope won almost any query.
 * - Neither arm is sufficient alone, and they fail on opposite inputs. Over ten queries on a
 *   live scope: vectors scored MRR 1.000 on natural-language questions but 0.529 on exact
 *   identifiers (`SettlementLayout.Build`, `SimTestsNet10.csproj`); BM25 scored 0.800 and
 *   0.600. Fused, 0.825 and 0.800 — better than either arm on the inputs it is worse at, and
 *   no worse where it already won. That trade is the whole argument for hybrid.
 * - Fusion is RRF rather than score blending: BM25 scores and cosine similarities live on
 *   different scales, and normalising them would need re-tuning per corpus.
 */
import type { DatabaseSync } from 'node:sqlite';
import { blobToVector, dot } from './embeddings.js';

/** One retrieved row, before fusion. */
export interface Ranked {
  id: string;
  score: number;
}

/**
 * Terms carrying no discriminative signal. The old tokenizer only dropped single characters,
 * which is why "what pose is the base character in" ranked on `is`/`in`/`the`.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'did', 'do', 'does',
  'for', 'from', 'get', 'had', 'has', 'have', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its',
  'me', 'my', 'no', 'not', 'of', 'on', 'or', 'our', 'so', 'that', 'the', 'their', 'them', 'then',
  'there', 'these', 'they', 'this', 'to', 'up', 'us', 'was', 'we', 'were', 'what', 'when', 'where',
  'which', 'who', 'why', 'will', 'with', 'you', 'your',
]);

/** FTS5 bareword syntax is fussy; quote every term and strip embedded quotes. */
function quote(term: string): string {
  return `"${term.replace(/"/g, '')}"`;
}

/**
 * Content terms from a natural-language question. Falls back to the unfiltered token list when
 * stopword removal would leave nothing (e.g. a query that is entirely stopwords).
 */
export function queryTerms(query: string): string[] {
  const all = (query.toLowerCase().match(/[a-z0-9][a-z0-9_.-]*/g) ?? []).filter((t) => t.length > 1);
  const content = all.filter((t) => !STOPWORDS.has(t));
  return content.length ? content : all;
}

/**
 * Any-term matching, ranked by BM25.
 *
 * An earlier revision required *all* terms (AND) and fell back to OR only when that returned
 * nothing, on the theory that OR would reproduce the old length bias. Measured over ten queries
 * on a live scope, that was wrong and actively harmful: MRR 0.688 with the AND arm versus 0.813
 * without it. AND over-constrains — "what pose is the base character in" matched exactly one
 * entry, the wrong one, and that lone hit then carried full weight into fusion. BM25's IDF and
 * length normalisation already solve the problem AND was defending against.
 *
 * Quoting each term also makes a dotted identifier (`SettlementLayout.Build`) a phrase query, so
 * it still matches text the tokenizer split on punctuation.
 */
export function buildMatchQuery(query: string): string | null {
  const terms = queryTerms(query);
  if (!terms.length) return null;
  return terms.map(quote).join(' OR ');
}

/**
 * BM25 over an FTS5 table. SQLite returns bm25() as a negative number where more negative is a
 * better match, so it is negated here — every score in this module is "higher is better".
 */
export function lexicalSearch(
  db: DatabaseSync,
  table: 'memory_fts' | 'chunk_fts',
  query: string,
  opts: { scope?: string; limit?: number } = {},
): Ranked[] {
  const match = buildMatchQuery(query);
  if (!match) return [];
  const limit = opts.limit ?? 20;
  const where = opts.scope ? `${table} MATCH ? AND scope = ?` : `${table} MATCH ?`;
  const args: (string | number)[] = opts.scope ? [match, opts.scope, limit] : [match, limit];
  try {
    const rows = db
      .prepare(`SELECT id, bm25(${table}) AS rank FROM ${table} WHERE ${where} ORDER BY rank LIMIT ?`)
      .all(...args) as { id: string; rank: number }[];
    return rows.map((r) => ({ id: r.id, score: -r.rank }));
  } catch {
    return []; // malformed MATCH expression -> no lexical arm, not a failed request
  }
}

/**
 * Brute-force cosine over the scope's stored vectors.
 *
 * Deliberately not a vector index: the whole corpus measured 2.3 MB of vectors and ~0.6M
 * multiply-adds per query. A vector database here would be an operational dependency bought
 * for a workload that fits in cache. Revisit above ~100k rows per scope.
 */
export function vectorSearch(
  db: DatabaseSync,
  kind: 'memory' | 'chunk',
  queryVec: Float32Array,
  opts: { scope?: string; limit?: number; model?: string } = {},
): Ranked[] {
  const limit = opts.limit ?? 20;
  const clauses = ['owner_kind = ?'];
  const args: (string | number | null)[] = [kind];
  if (opts.scope) {
    clauses.push('scope = ?');
    args.push(opts.scope);
  }
  if (opts.model) {
    clauses.push('model = ?');
    args.push(opts.model);
  }
  const rows = db
    .prepare(`SELECT owner_id, vec FROM embeddings WHERE ${clauses.join(' AND ')}`)
    .all(...args) as { owner_id: string; vec: Uint8Array }[];

  const scored: Ranked[] = [];
  for (const row of rows) {
    const v = blobToVector(row.vec);
    if (v.length !== queryVec.length) continue; // stale model/dimension -> ignore, don't crash
    scored.push({ id: row.owner_id, score: dot(queryVec, v) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Reciprocal rank fusion. `k` damps the influence of any single list's top rank; 60 is the
 * value from the original RRF paper and is not sensitive at this corpus size.
 */
export function fuseRRF(lists: Ranked[][], k = 60): Ranked[] {
  const totals = new Map<string, number>();
  for (const list of lists) {
    list.forEach((row, i) => {
      totals.set(row.id, (totals.get(row.id) ?? 0) + 1 / (k + i + 1));
    });
  }
  return [...totals.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
