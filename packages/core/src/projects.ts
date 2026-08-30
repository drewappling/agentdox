import type { Project } from '@agentdox/types';
import type { Store } from './db.js';
import { newId, nowIso } from './util.js';

interface Row {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  owner_sub: string | null;
  created_at: string;
}

export interface NewProject {
  slug: string;
  /** Display name. Only used when the project is created; defaults to the slug. */
  name?: string;
  description?: string;
  ownerSub?: string;
}

const toProject = (r: Row): Project => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  description: r.description ?? undefined,
  ownerSub: r.owner_sub ?? undefined,
  createdAt: r.created_at,
});

/** A named workspace whose `slug` is the agentdox scope namespace. */
export class ProjectService {
  constructor(private readonly store: Store) {}

  list(): Project[] {
    const rows = this.store.db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as unknown as Row[];
    return rows.map(toProject);
  }

  get(slug: string): Project | null {
    const row = this.store.db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug) as Row | undefined;
    return row ? toProject(row) : null;
  }

  getById(id: string): Project | null {
    const row = this.store.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
    return row ? toProject(row) : null;
  }

  /**
   * Create if absent, otherwise return the existing project (idempotent for agents).
   *
   * `name` is optional and only consulted on creation: agents are told to call this on every
   * connect, and by then the project almost always exists, so demanding a display name each
   * time is friction with nothing behind it. An existing project's name is never overwritten
   * here — renaming is a deliberate act, not a side effect of saying hello.
   */
  ensure(input: NewProject): Project {
    const existing = this.get(input.slug);
    if (existing) return existing;
    const id = newId('proj');
    this.store.db
      .prepare('INSERT INTO projects (id, slug, name, description, owner_sub, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, input.slug, input.name ?? input.slug, input.description ?? null, input.ownerSub ?? null, nowIso());
    return this.get(input.slug) as Project;
  }

  /**
   * Delete a project and all of its scoped data (memory, docs+versions, sessions+messages
   * keyed by that scope). Returns true if a project existed.
   */
  remove(slug: string): boolean {
    if (!this.get(slug)) return false;
    // One transaction so a crash can't leave a project half-deleted. Retrieval indexes are keyed
    // by scope, so drop them here too: the per-entity remove() methods that normally clean the
    // FTS/vector rows are bypassed by these bulk deletes.
    this.store.tx(() => {
      this.store.db.prepare('DELETE FROM memory WHERE category = ?').run(slug);
      this.store.db.prepare('DELETE FROM docs WHERE scope = ?').run(slug); // cascades doc_versions
      this.store.db.prepare('DELETE FROM sessions WHERE scope = ?').run(slug); // cascades messages
      this.store.db.prepare('DELETE FROM doc_chunks WHERE scope = ?').run(slug);
      this.store.db.prepare('DELETE FROM memory_fts WHERE scope = ?').run(slug);
      this.store.db.prepare('DELETE FROM chunk_fts WHERE scope = ?').run(slug);
      this.store.db.prepare('DELETE FROM message_fts WHERE scope = ?').run(slug);
      this.store.db.prepare('DELETE FROM embeddings WHERE scope = ?').run(slug);
      this.store.db.prepare('DELETE FROM projects WHERE slug = ?').run(slug);
    });
    return true;
  }
}
