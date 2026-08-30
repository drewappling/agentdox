# RAG support for agentdox

**Status:** Implemented (v1.1). Stages 1–4 shipped, plus session retrieval, a self-healing
index, MCP/SDK surfaces, and a regression fixture; §4 records the plan, §8 what was built and
what the plan got wrong.
**Scope:** Retrieval quality across memory, docs, and context assembly.
**Measured:** 2026-08-29, against the live store (213 items across `acme`, `web-app`, `agentdox`).

---

## 1. The premise

agentdox already *is* a retrieval-augmented system: `context.assemble` selects memory + docs +
session history and hands an agent one block. What it lacks is a retrieval *engine*. Everything
is ranked by one function, `relevanceScore` in `packages/core/src/util.ts`:

```ts
// sum of query-token occurrences across the fields, normalised by query length
score = Σ count(token) / sqrt(|queryTokens|)
```

That is raw term frequency. It has no IDF, no document-length normalisation, no stemming, and its
only stopword rule is `t.length > 1` — so `in`, `is`, `me`, `do`, `we` are all scored terms.

The consequences are not theoretical. They were measured on the `acme` scope (94 memory
entries, 100 docs).

## 2. Measured failures

### 2.1 Length bias

Across one query scored over all 94 entries, **Pearson r(content length, score) = 0.423**. Long
entries win because they contain more of every token. Mean entry is 731 chars; the winners are
consistently the 3,000+ char ones.

### 2.2 Wrong answers when the right one exists

Query: **"which module is in the base request path"**

| Rank | Today (`relevanceScore`) | With BM25 |
| --- | --- | --- |
| 1 | DATA IMPORT — ingest BATCH… (3,481 ch) | **How the base request path is resolved** |
| 2 | REGION CACHE + BATCH JOB… (3,130 ch) | Hybrid retry gate for batch jobs |
| 3 | REQUEST ROUTING FIX… (3,306 ch) | config-lite request-schema traps |

The correct entry exists and is never returned. The three that are returned are simply the three
longest entries in the scope — they matched on `is`, `in`, `the`, `base`.

### 2.3 Whole-doc retrieval, then blind truncation

Docs are scored and returned whole, then `MAX_DOC_CHARS = 2000` trims them during assembly. For
`acme/docs/api-redesign.md` (43,959 chars) that injects **the first 4.5% of the
document** — its preamble — regardless of which passage was relevant.

Query: **"how are routes generated"**

- Today: `api-redesign.md`, truncated to its opening.
- Chunked + BM25: `acme/docs/systems/routing.md#13` → *"## What is NOT done — Routes are not in
  the runtime pipeline…"*, ~1.2k chars, the passage that actually answers it.

### 2.4 The class BM25 does *not* fix

Query: **"stop the agent re-asking me questions"** fails under both the current scorer *and* BM25.
It returns data-pipeline and platform-svc entries. The material that answers it — the project
brief and context-assembly entries — shares no vocabulary with the question. This is
vocabulary mismatch, and it is the only failure class in the sample that genuinely requires
embeddings.

## 3. Capability findings

| Finding | Consequence |
| --- | --- |
| **FTS5 with `bm25()` is available in the built-in `node:sqlite`** (SQLite 3.51.3, verified in the running container) | A proper lexical engine costs **zero new dependencies**. `core` stays native-dep-free. |
| `DatabaseSync` accepts `allowExtension: true` | `sqlite-vec` is *possible*, but needs a per-platform binary. §5 argues it is unnecessary. |
| Corpus is **213 items / 947k chars ≈ 237k tokens** | A full re-embed costs **$0.0047** at `text-embedding-3-small` rates. Cost is not a design constraint. |
| ~789 chunks × 768 dims × float32 = **2.3 MB**, 0.61M multiply-adds per query | Brute-force cosine in JS is ~1 ms. **No vector database is warranted.** |
| Ollama is **not currently listening** on `:11434` | Any embedding provider must be optional and degrade to lexical, never hard-fail retrieval. |
| `MemoryEntry.embedding?: number[]` exists in `@agentdox/types`, and `embedding_json` in `memory.ts`'s row interface — but **no column in the schema and no code that reads or writes it** | The public type already advertises semantic search that does not exist. Either implement it or delete it; leaving it is a promise the store does not keep. |

## 4. Proposed staging

Ordered by measured value per unit of work. Each stage stands alone and ships independently.

### Stage 1 — Lexical rebuild (no new dependencies)

Replace `relevanceScore` with FTS5 + `bm25()`.

- `memory_fts` and `chunk_fts` virtual tables, kept in sync from the services that already own
  writes (`MemoryService`, `DocService`) — external-content tables, or plain mirrors with an
  explicit reindex, whichever keeps the write path simple.
- Keep the `importance` nudge on memory, and keep the min-importance top-up in assembly: those are
  agentdox-specific ranking signals BM25 knows nothing about.
- Query construction matters. Naive `OR` over every term reproduces the length bias (an artefact
  visible in the prototype: an unrelated regions chunk outscored the right one on a term-OR query).
  Use phrase and AND-biased queries with a proper stopword list, falling back to OR only on empty
  results.

Fixes §2.1 and §2.2.

### Stage 2 — Chunking as the retrieval unit

Docs become passages: split on markdown headings, cap ~1,200 chars, keep the parent `doc_id`,
slug, heading path, and ordinal. 100 docs → ~1,011 chunks in the prototype.

- Retrieval returns chunks; assembly injects chunks with a heading breadcrumb and a link back to
  the doc, replacing the blind `MAX_DOC_CHARS` cut.
- Memory entries stay whole — they are already atomic single facts, which is exactly the
  granularity chunking is trying to manufacture. This is a genuine strength of the existing memory
  model and should not be undone.

Fixes §2.3, and is a prerequisite for embeddings being useful (embedding a 44k-char doc as one
vector is close to meaningless).

### Stage 3 — Optional embeddings

- `EmbeddingProvider` interface: `embed(texts: string[]): Promise<Float32Array[]>`, with `ollama`
  (local, free, private — a local model server), `openai`, and `none` implementations,
  selected by env (`AGENTDOX_EMBED_PROVIDER`, `AGENTDOX_EMBED_MODEL`).
- Store vectors as `BLOB` next to each chunk and memory row, with the model id and dimension.
  A model change invalidates the column — record it rather than silently mixing vector spaces.
- Brute-force cosine over the scope's rows. Revisit only if a scope exceeds ~100k chunks, which
  is roughly 100× the current corpus.
- **Degradation is a requirement, not a nicety.** Provider down or unconfigured ⇒ lexical-only
  results, logged once, never an error to the agent. Ollama was already down during this research.
- Backfill reuses the existing scheduler pattern (`AGENTDOX_CONTEXT_INTERVAL_SECONDS` / context
  snapshots) rather than inventing a second job runner.

Fixes §2.4.

### Stage 4 — Hybrid fusion

Reciprocal-rank fusion over the BM25 and vector result lists (`score = Σ 1/(k + rank)`, k≈60),
then apply the importance/recency nudges once, at the end. RRF is chosen over score blending
because BM25 scores and cosine similarities are not on comparable scales and their normalisation
would need re-tuning per corpus.

Reranking (cross-encoder or LLM-as-judge) is explicitly **out of scope** until there is evidence
that fusion is insufficient — it adds a model call to the hot path that the web-app pays for
on every context refresh.

## 5. What not to build

- **A vector database.** 2.3 MB of vectors and 0.61M mul-adds per query. Postgres+pgvector,
  Qdrant, or Chroma would add an operational dependency to a system whose entire retrieval
  workload fits in L2 cache.
- **`sqlite-vec`.** Same reasoning, plus a per-platform native binary in a package that currently
  has none.
- **Re-chunking memory.** Entries are already one-fact-each by protocol.
- **Embedding-only retrieval.** §2.2's win came from BM25; exact identifiers (`OrderService`,
  `AGENTDOX_TOKEN`, `bm25()`) are precisely what lexical search is good at and dense retrieval is
  bad at. Hybrid or nothing.

## 6. Decisions taken

1. **Default embedding provider is `none`.** An unconfigured install makes no network calls and
   stays lexical-only. This deployment sets `AGENTDOX_EMBED_PROVIDER=ollama` against
   `host.docker.internal:11434` with `nomic-embed-text` (768 dims).
2. **Assembly injects passages when the request carries a query**, and whole (trimmed) docs when
   it does not — with no query there is nothing to rank passages by. Passages render with a
   `slug § heading` breadcrumb so an agent can open the full doc.
3. **The vestigial `embedding` field was deleted** from `@agentdox/types`. Vectors live in their
   own `embeddings` table keyed by `(owner_kind, owner_id)`, which the field's shape could not
   express.
4. **The ten queries are not yet a CI fixture.** They exist as a throwaway harness. Promoting
   them is the obvious next step and the one thing most likely to stop a future ranking change
   silently regressing.

## 7. As built

| Piece | Where |
| --- | --- |
| Markdown-aware chunker (heading split, ~1,200 char cap, runt folding) | `core/src/chunking.ts` |
| Providers (Ollama, OpenAI-compatible, none) + L2 normalise + blob pack | `core/src/embeddings.ts` |
| BM25 query building, vector scan, RRF | `core/src/retrieval.ts` |
| Index maintenance, backfill, rebuild, stats | `core/src/indexer.ts` |
| `doc_chunks`, `memory_fts`, `chunk_fts`, `embeddings` | `core/src/db.ts` |
| `GET /index/stats`, `POST /index/rebuild` (wildcard admin), `GET /docs/passages` | `server/src/index.ts` |
| Embedding top-up on each context-scheduler tick | `server/src/index.ts` |
| MCP `docs_passages`, `index_stats`, `index_rebuild` | `mcp/src/index.ts` |
| SDK `client.docs.passages`, `client.index.{stats,rebuild}` | `sdk/src/index.ts` |
| Ranking regression fixture (`npm run test:retrieval`) | `scripts/test-retrieval.mjs` |

**Sessions are retrieved, not just replayed.** Conversation reached the block by recency alone,
so anything discussed further back than `sessionLimit` was unreachable however directly it
answered the query. Messages are now indexed (`message_fts` + vectors) and the budget is split:
two thirds is the recent tail, for continuity, and the remainder is relevance-ranked older
messages, merged chronologically. Measured on `acme` with `sessionLimit: 9`, the block
reaches message ids 75-137 where recency alone would have given 130-137.

**The index heals itself.** `AgentDox` checks on open and rebuilds the lexical index when it
finds content the index does not cover — an upgraded store, a restored backup, rows written
straight into SQLite. Lexical only; vectors stay with the backfill job.
`AGENTDOX_INDEX_AUTOBUILD=false` opts out. A rebuild also prunes vectors whose owner row is
gone: chunk ids are regenerated on every doc write, so orphans accumulated silently and were
scanned on every query (observed once as 1,902 vectors against 1,646 chunks).

`MemoryService.search`, `DocService.search`, `ContextService.assemble` and `saveSnapshot` are now
async, since the vector arm has to embed the query.

**Two speeds, deliberately.** FTS rows are written synchronously inside the same call that writes
the memory entry or doc, so a fact is searchable the moment it is stored. Vectors are backfilled
by the scheduler, never on the write path: embedding calls a model server that can be stopped, and
`memory_add` must not fail — or wait on an HTTP round-trip — for a retrieval nicety. A provider
that is down means the vector arm contributes nothing; it is never an error.

Live numbers on this store: 128 memory entries and 1,643 chunks index in ~1.6 s, embed in ~26 s
against local Ollama. Query latency end-to-end, including the query embedding, is 27–137 ms.

## 8. Where the plan was wrong

Two things in §4 did not survive contact with measurement.

**The AND-first query builder was actively harmful.** §4's Stage 1 argued that a term-OR query
would reproduce the length bias, so matching should require all terms and fall back to OR. It does
the opposite. `"what pose is the base character in"` matched exactly one entry under AND — the
wrong one — and that lone hit then carried a full 1/(k+1) into fusion and won. BM25's IDF and
length normalisation already solve what AND was defending against. Measured over ten queries:

| config | MRR natural-language | MRR identifier | MRR overall |
| --- | --- | --- | --- |
| AND-then-OR + vectors *(as planned)* | 0.575 | 0.800 | 0.688 |
| **OR + vectors** *(shipped)* | **0.825** | **0.800** | **0.813** |
| AND + OR + vectors | 0.575 | 0.800 | 0.688 |
| lexical only | 0.800 | 0.600 | 0.700 |
| vectors only | 1.000 | 0.529 | 0.764 |

**Asymmetric models need task prefixes.** `nomic-embed-text` is trained with `search_query:` /
`search_document:`, and embedding both sides bare measurably weakens the vector arm. Prefixes are
applied per model family in `embeddings.ts`; symmetric models (OpenAI) get none.

The bottom row of that table is also the clearest evidence for hybrid over either arm alone:
vectors are perfect on natural-language questions and worst on exact identifiers
(`OrderService.submit`, `Api.Tests.csproj`); lexical is the reverse. Fusing them keeps each
arm's strength on the inputs the other fumbles.

**Still unsolved:** `"stop the agent re-asking me questions"` improved from absent to rank 7, but
no configuration puts it first. The material that answers it is a standing rule about syncing
agentdox at session end; nothing in the query's vocabulary or embedding neighbourhood points
there. A reranking pass is the remaining lever, at the cost of a model call on the hot path.

## 9. Reproducing the measurements

The numbers in §2–§3 come from querying the live store over REST and rebuilding the index in a
throwaway in-memory `node:sqlite` database — no changes to the running server. Method: pull
`/memory?category=<scope>` and `/docs?scope=<scope>`, index into `fts5(id UNINDEXED, body)`, split
docs on `/\n(?=#{1,4}\s)/` with a 1,200-char cap, and compare `ORDER BY bm25()` against the same
queries run through `/memory/search` and `/docs/search`.
