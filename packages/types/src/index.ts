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
  /** If a provider computed one, an embedding vector for semantic search. */
  embedding?: number[];
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
}

/** A ranked memory hit. */
export interface MemoryHit {
  entry: MemoryEntry;
  score: number;
}

/** A context slice: the fully assembled, ready-to-inject block. */
export interface ContextSlice {
  request: ContextRequest;
  assembledAt: string;
  memory: MemoryHit[];
  docs: Doc[];
  sessionMessages: SessionMessage[];
  /** The rendered, prompt-ready text block built from the above. */
  prompt: string;
  /** Rough character budget consumed by the assembly. */
  chars: number;
}

// ---- Projects ----

/**
 * A named workspace. `slug` doubles as the agentdox `scope` namespace, so memory, docs,
 * and sessions keyed by that scope belong to the project. Agents create/ensure projects
 * dynamically on connect.
 */
export interface Project {
  id: string;
  /** URL-ish, immutable key; also the scope namespace (e.g. "ashlands"). */
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

