import type { Store } from './db.js';
import { openDatabase } from './db.js';
import { MemoryService } from './memory.js';
import { DocService } from './docs.js';
import { SessionService } from './sessions.js';
import { ContextService } from './context.js';
import { PatService } from './pat.js';
import { ProjectService } from './projects.js';

export { openDatabase, type Store } from './db.js';
export { MemoryService } from './memory.js';
export { DocService } from './docs.js';
export { SessionService } from './sessions.js';
export { ContextService } from './context.js';
export type { ContextSnapshot, ProjectBrief, DecisionEntry } from './context.js';
export { PatService } from './pat.js';
export { ProjectService } from './projects.js';
export { newId, nowIso, relevanceScore, tokenize } from './util.js';

/** The top-level facade tying storage + services together. */
export class AgentDox {
  readonly store: Store;
  readonly memory: MemoryService;
  readonly docs: DocService;
  readonly sessions: SessionService;
  readonly context: ContextService;
  readonly pat: PatService;
  readonly projects: ProjectService;

  constructor(dbPath = 'data/agentdox.db') {
    this.store = openDatabase(dbPath);
    this.memory = new MemoryService(this.store);
    this.docs = new DocService(this.store);
    this.sessions = new SessionService(this.store);
    this.context = new ContextService({ memory: this.memory, docs: this.docs, sessions: this.sessions, store: this.store });
    this.pat = new PatService(this.store);
    this.projects = new ProjectService(this.store);
  }

  close(): void {
    this.store.close();
  }
}
