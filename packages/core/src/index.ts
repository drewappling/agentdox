import type { Store } from './db.js';
import { isPostgresUrl, openStore } from './db.js';
import { MemoryService } from './memory.js';
import { DocService } from './docs.js';
import { SessionService } from './sessions.js';
import { ContextService } from './context.js';
import { PatService } from './pat.js';
import { ProjectService } from './projects.js';
import { IndexService } from './indexer.js';
import { createEmbeddingProvider, readEmbeddingConfig } from './embeddings.js';
import { exportScope, importScope } from './transfer.js';
import type { ScopeExport, ScopeImportReport } from '@agentdox/types';

export { openStore, openDatabase, isPostgresUrl, type Store, type Dialect, type Param, type Row, type PostgresOptions } from './db.js';
export { MemoryService } from './memory.js';
export { DocService } from './docs.js';
export { SessionService } from './sessions.js';
export { ContextService } from './context.js';
export type { ContextSnapshot, ProjectBrief, DecisionEntry, AssembleOptions } from './context.js';
export { exportScope, importScope, parseScopeExport, type TransferDeps } from './transfer.js';
export { PatService } from './pat.js';
export { ProjectService } from './projects.js';
export { IndexService, type IndexStats } from './indexer.js';
export type { ChunkHit } from './docs.js';
export { chunkMarkdown, type Chunk } from './chunking.js';
export {
  createEmbeddingProvider,
  readEmbeddingConfig,
  type EmbeddingProvider,
  type EmbeddingConfig,
  type EmbedKind,
} from './embeddings.js';
export { fuseRRF, lexicalSearch, vectorSearch, queryTerms, buildMatchQuery } from './retrieval.js';
export { copyStore, storeRowCount, type CopyOptions, type CopyReport } from './migrate.js';
export { newId, nowIso, relevanceScore, tokenize } from './util.js';

/** The top-level facade tying storage + services together. Open one with `AgentDox.open()`. */
export class AgentDox {
  readonly memory: MemoryService;
  readonly docs: DocService;
  readonly sessions: SessionService;
  readonly context: ContextService;
  readonly pat: PatService;
  readonly projects: ProjectService;
  readonly index: IndexService;

  private constructor(
    readonly store: Store,
    env: NodeJS.ProcessEnv,
  ) {
    this.memory = new MemoryService(store);
    this.docs = new DocService(store);
    // Retrieval indexes. The embedding provider is optional: with none configured, search is
    // lexical-only, which is the documented degradation rather than a failure.
    this.index = new IndexService(store, createEmbeddingProvider(readEmbeddingConfig(env)));
    this.sessions = new SessionService(store);
    this.memory.setIndexer(this.index);
    this.docs.setIndexer(this.index);
    this.sessions.setIndexer(this.index);
    this.context = new ContextService({ memory: this.memory, docs: this.docs, sessions: this.sessions, store });
    this.pat = new PatService(store);
    this.projects = new ProjectService(store);
  }

  /**
   * Open the store and wire the services. `target` is a SQLite file path (one process, one
   * machine) or a `postgres://` URL (several instances sharing a store; tables live under the
   * schema `AGENTDOX_PG_SCHEMA`, default `agentdox`).
   */
  static async open(target = 'data/agentdox.db', env: NodeJS.ProcessEnv = process.env): Promise<AgentDox> {
    const store = await openStore(target, { schema: env.AGENTDOX_PG_SCHEMA });
    const dox = new AgentDox(store, env);
    // Self-heal on open. A store written before the index tables existed — or restored from a
    // backup, or loaded straight into the database — would otherwise sit on an empty index and
    // quietly serve the legacy fallback until somebody knew to call /index/rebuild by hand.
    // Lexical only: it is pure database work and fast (~1.6s for 1,643 chunks). Vectors stay
    // with the backfill job.
    if (env.AGENTDOX_INDEX_AUTOBUILD !== 'false' && (await dox.index.needsLexicalBuild())) {
      const b = await dox.index.rebuildLexical();
      console.error(`[agentdox] built retrieval index: ${b.memory} memory, ${b.chunks} chunks, ${b.messages} messages`);
    }
    return dox;
  }

  /** Everything `scope` holds as one JSON document, for offboarding, migration or a backup. */
  exportScope(scope: string): Promise<ScopeExport> {
    return exportScope(this, scope);
  }

  /** Write a `ScopeExport` into this store under the scope it names, upserting by id. */
  importScope(payload: ScopeExport): Promise<ScopeImportReport> {
    return importScope(this, payload);
  }

  /** Where the data lives, for logs and health: `sqlite:<path>` or `postgres:<host>/<db> (schema …)`. */
  get storage(): string {
    return this.store.description;
  }

  /** True when `target` names a Postgres store rather than a SQLite file. */
  static isPostgres(target: string): boolean {
    return isPostgresUrl(target);
  }

  async close(): Promise<void> {
    await this.store.close();
  }
}
