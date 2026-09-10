/**
 * One scope in, one scope out. `exportScope` gathers everything a scope holds — the project
 * row, the brief, memory, docs with their revisions, sessions with their messages — into a single
 * JSON document, and `importScope` writes such a document into a store under whatever scope the
 * document names. Offboarding (hand a member their thread), migration (move a project to another
 * deployment), a backup and its restore all reduce to the two.
 *
 * Import upserts by id, so the same document twice leaves the store as it was; the document's
 * `scope` overrides the entries' own category/scope, so renaming a scope is editing one field.
 * The retrieval index is written alongside every row, the same as on the normal write path.
 */
import type { ScopeExport, ScopeImportReport } from '@agentdox/types';
import type { ContextService } from './context.js';
import type { DocService } from './docs.js';
import type { MemoryService } from './memory.js';
import type { ProjectService } from './projects.js';
import type { SessionService } from './sessions.js';
import type { Store } from './db.js';
import { nowIso } from './util.js';

/** The services a transfer touches; `AgentDox` satisfies it. */
export interface TransferDeps {
  memory: MemoryService;
  docs: DocService;
  sessions: SessionService;
  context: ContextService;
  projects: ProjectService;
  store: Store;
}

export const EXPORT_FORMAT = 'agentdox-export';
export const EXPORT_VERSION = 1;

/** The list services cap their results; an export wants every row. */
const EVERYTHING = 1_000_000;

/** Everything `scope` holds. A scope with nothing in it exports empty arrays and nulls. */
export async function exportScope(deps: TransferDeps, scope: string): Promise<ScopeExport> {
  const docs: ScopeExport['docs'] = [];
  for (const doc of await deps.docs.list({ scope, limit: EVERYTHING })) docs.push({ ...doc, versions: await deps.docs.history(doc.id) });
  const sessions: ScopeExport['sessions'] = [];
  for (const s of await deps.sessions.list(scope, EVERYTHING)) sessions.push({ ...s, messages: await deps.sessions.messages(s.id, EVERYTHING) });
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    scope,
    exportedAt: nowIso(),
    project: await deps.projects.get(scope),
    brief: await deps.context.getBrief(scope),
    memory: await deps.memory.list({ category: scope, limit: EVERYTHING }),
    docs,
    sessions,
  };
}

/**
 * Read an untrusted body as an export document: the format and version must match and a scope
 * must be named; the collections default to empty when absent. Null when it is not one.
 */
export function parseScopeExport(body: unknown): ScopeExport | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Partial<ScopeExport>;
  if (b.format !== EXPORT_FORMAT || Number(b.version) !== EXPORT_VERSION) return null;
  if (typeof b.scope !== 'string' || !b.scope.trim()) return null;
  const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    scope: b.scope.trim(),
    exportedAt: typeof b.exportedAt === 'string' ? b.exportedAt : nowIso(),
    project: b.project && typeof b.project === 'object' ? b.project : null,
    brief: b.brief && typeof b.brief === 'object' ? b.brief : null,
    memory: list(b.memory),
    docs: list(b.docs),
    sessions: list(b.sessions),
  };
}

/**
 * Write `payload` into the store under `payload.scope`, in one transaction: the project row is
 * created when the slug is new (an existing one is never renamed), the brief is replaced whole
 * when present, and memory, docs (with their revisions) and sessions (with their messages) are
 * upserted by id. The counts report what was written, whether or not it was already there.
 */
export async function importScope(deps: TransferDeps, payload: ScopeExport): Promise<ScopeImportReport> {
  const parsed = parseScopeExport(payload);
  if (!parsed) throw new Error('not an agentdox export document');
  const scope = parsed.scope;
  return deps.store.tx(async () => {
    if (parsed.project) {
      await deps.projects.ensure({ slug: scope, name: parsed.project.name, description: parsed.project.description, ownerSub: parsed.project.ownerSub });
    }
    if (parsed.brief) await deps.context.putBrief(scope, parsed.brief);
    for (const entry of parsed.memory) await deps.memory.upsert({ ...entry, category: scope });
    for (const { versions, ...doc } of parsed.docs) await deps.docs.upsert({ ...doc, scope }, versions);
    let messages = 0;
    for (const session of parsed.sessions) messages += await deps.sessions.upsert({ ...session, scope, messages: session.messages ?? [] });
    return { memory: parsed.memory.length, docs: parsed.docs.length, sessions: parsed.sessions.length, messages, brief: parsed.brief !== null };
  });
}
