/**
 * agentdox domain model.
 *
 * Four first-class concepts:
 *   - Memory   : durable, high-signal facts. Compact entries that can be evicted.
 *   - Doc      : versioned markdown documentation.
 *   - Session  : a running agent conversation (history a context can draw on).
 *   - Context  : the *assembled* slice of memory + docs + sessions, computed on demand.
 *
 * All IDs are opaque strings (recommended: nanoid / uuid).
 */

/** A compact, durable fact stored in agent memory. */
export interface MemoryEntry {
  id: string;
  /** The fact itself. Keep compact and high-signal. */
  content: string;
  /** Free-form category for scoping (e.g. "user", "project", "tooling"). */
  category?: string;
  /** A sub-scope within a category, e.g. the thing the entry is *about*. */
  target?: string;
  /** 0..1 importance; drives eviction and ranking. Default 0.5. */
  importance: number;
  /** Free-form tags for filtering. */
  tags: string[];
  /** When the fact was written. */
  createdAt: string;
  /** When it was last touched. */
  updatedAt: string;
  /** Optional provenance, e.g. "user-stated", "inferred", or a session id. */
  source?: string;
}

export type MemoryTarget = 'user' | 'memory';

/** A versioned markdown document. */
export interface Doc {
  id: string;
  /** Stable URL-ish key, e.g. "guides/pixel-art". */
  slug: string;
  title: string;
  /** Markdown body. */
  content: string;
  tags: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Which agent/context this doc belongs to, if any. */
  scope?: string;
}

export interface DocVersion {
  version: number;
  content: string;
  updatedAt: string;
}

/** A single message in a session. */
export interface SessionMessage {
  /** Row id, present on messages read back from the store. Used to de-duplicate retrieval. */
  id?: number;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  at: string;
  /** Attach a source memory/doc entry id if this message produced/consumed one. */
  refs?: string[];
}

/** A running agent conversation history. */
export interface Session {
  id: string;
  /** Which agent/topic this session belongs to. */
  scope: string;
  title: string;
  startedAt: string;
  endedAt: string | null;
  messages: SessionMessage[];
}

/** Options describing what to assemble for a given context request. */
export interface ContextRequest {
  /** Which agent/project scope to draw from. */
  scope: string;
  /** A task/question to bias relevance of retrieved entries. */
  query?: string;
  /** Cap on memory entries included. */
  memoryLimit?: number;
  /** Cap on docs included. */
  docsLimit?: number;
  /** Cap on recent session messages included. */
  sessionLimit?: number;
  /** Only include memory above this importance when low on budget. */
  minImportance?: number;
  /**
   * Budget for the project brief, in characters. The brief is the most curated
   * content in the store — overview, conventions, gotchas, decision log — and it
   * is query-INDEPENDENT, so it belongs at the FRONT of the block where a
   * consumer's prompt cache can hold it across turns.
   *
   * It also grows without bound: one entry is appended per recorded decision, so
   * it needs a budget rather than a "include it all" switch. Static sections are
   * always kept (measured: ~1.6k chars); the decision log takes what remains,
   * newest first, since the newest decision is the one still in force.
   *
   * 0 (the default) omits the brief entirely — no behaviour change for callers
   * that have not asked for it.
   */
  briefChars?: number;
}

/** A ranked memory hit. */
export interface MemoryHit {
  entry: MemoryEntry;
  score: number;
}

/** A context slice: the fully assembled, ready-to-inject block. */
/**
 * One retrieved passage of a document. Retrieval works on passages rather than whole documents:
 * scoring a 44k-char doc entire and then truncating it to a fixed budget injected its preamble
 * instead of the part that matched.
 */
export interface DocPassage {
  id: string;
  docId: string;
  slug: string;
  title: string;
  /** Heading breadcrumb within the doc, e.g. "Roads > What is NOT done". */
  heading: string;
  ordinal: number;
  content: string;
  score: number;
}

export interface ContextSlice {
  request: ContextRequest;
  assembledAt: string;
  memory: MemoryHit[];
  docs: Doc[];
  /** Passages actually rendered into `prompt`, when the request carried a query. */
  passages?: DocPassage[];
  sessionMessages: SessionMessage[];
  /** The rendered, prompt-ready text block built from the above. */
  prompt: string;
  /** Rough character budget consumed by the assembly. */
  chars: number;
  /** Characters the project brief contributed to `prompt`. 0 when not requested. */
  briefChars: number;
}

/** Retrieval-index coverage for a scope (or the whole store when unscoped). */
export interface IndexStats {
  memory: { total: number; embedded: number };
  chunks: { total: number; embedded: number };
  messages: { total: number; embedded: number };
  /** Configured embedding provider id, or null when retrieval is lexical-only. */
  provider: string | null;
  model: string | null;
  /**
   * Whether the provider answered a reachability probe. null when none is configured.
   * Retrieval degrades to lexical silently by design, so this is how a stopped model
   * server becomes visible instead of just quietly absent from every ranking.
   */
  providerReachable: boolean | null;
  providerCheckedAt: string | null;
}

/** Result of a full index rebuild. */
export interface IndexRebuildResult {
  lexical: { memory: number; chunks: number; messages: number };
  embedded: { embedded: number; pending: number; error?: string } | null;
  stats?: IndexStats;
}

/** A persisted, auto-refreshed context baseline for one scope/project (auto-context job). */
export interface ContextSnapshot {
  scope: string;
  query: string;
  prompt: string;
  chars: number;
  memoryHits: number;
  docs: number;
  sessionMsgs: number;
  assembledAt: string;
}

/** One entry in the project's historic decision/convention log. */
export interface DecisionEntry {
  id: string;
  title: string;
  decision: string;
  rationale: string;
  at: string;
}

/** The durable, cumulative on-ramp ("historic context") for a project/scope. */
export interface ProjectBrief {
  scope: string;
  overview: string;
  repoLayout: string;
  codeStyle: string;
  buildTest: string;
  assetConventions: string;
  gotchas: string;
  decisionLog: DecisionEntry[];
  updatedAt: string;
}

// ---- Projects ----

/**
 * A named workspace. `slug` doubles as the agentdox `scope` namespace, so memory, docs,
 * and sessions keyed by that scope belong to the project. Agents create/ensure projects
 * dynamically on connect.
 */
export interface Project {
  id: string;
  /** URL-ish, immutable key; also the scope namespace (e.g. "acme"). */
  slug: string;
  /** Human-friendly display name. */
  name: string;
  description?: string;
  /** Scope grant owner (sub), if it was agent-provisioned. */
  ownerSub?: string;
  createdAt: string;
}

/** Result of provisioning a project: the project plus an optional freshly-issued token. */
export interface ProjectProvision {
  project: Project;
  /** A project-scoped PAT (`{slug}:admin`) minted on first claim — shown exactly once. */
  token: string | null;
  expiresAt?: number | null;
}

// ---- Authentication & authorization ----

/** Per-scope access level. Inherits: admin ⊃ write ⊃ read ⊃ none. */
export type Role = 'none' | 'read' | 'write' | 'admin';

/** How a caller proved who they are. */
export type PrincipalKind = 'oidc' | 'pat' | 'local';

/**
 * A verified caller. `grants` maps an agentdox scope (project namespace) to the role
 * the caller holds there. Single-user / auth-disabled -> '*' maps to 'admin'.
 */
export interface Principal {
  /** Stable identity (OIDC `sub`, or PAT owner, or 'local'). */
  sub: string;
  name?: string;
  email?: string;
  kind: PrincipalKind;
  grants: Record<string, Role>;
}

/** Role hierarchy helper: admin ⊃ write ⊃ read ⊃ none. */
export const ROLE_ORDER: Role[] = ['none', 'read', 'write', 'admin'];

export function roleAtLeast(actual: Role, required: Role): boolean {
  return ROLE_ORDER.indexOf(actual) >= ROLE_ORDER.indexOf(required);
}

