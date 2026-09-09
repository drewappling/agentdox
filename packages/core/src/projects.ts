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

  async list(): Promise<Project[]> {
    const rows = await this.store.all<Row>('SELECT * FROM projects ORDER BY created_at DESC');
    return rows.map(toProject);
  }

  async get(slug: string): Promise<Project | null> {
    const row = await this.store.get<Row>('SELECT * FROM projects WHERE slug = ?', [slug]);
    return row ? toProject(row) : null;
  }

  async getById(id: string): Promise<Project | null> {
    const row = await this.store.get<Row>('SELECT * FROM projects WHERE id = ?', [id]);
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
  async ensure(input: NewProject): Promise<Project> {
    const existing = await this.get(input.slug);
    if (existing) return existing;
    const id = newId('proj');
    // Two agents saying hello at once: the second insert loses on the unique slug and reads
    // back what the first one made.
    await this.store
      .run('INSERT INTO projects (id, slug, name, description, owner_sub, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
        id,
        input.slug,
        input.name ?? input.slug,
        input.description ?? null,
        input.ownerSub ?? null,
        nowIso(),
      ])
      .catch(async (e: unknown) => {
        if (await this.get(input.slug)) return;
        throw e;
      });
    return (await this.get(input.slug)) as Project;
  }

  /**
   * Delete a project and all of its scoped data (memory, docs+versions, sessions+messages
   * keyed by that scope). Returns true if a project existed.
   */
  async remove(slug: string): Promise<boolean> {
    if (!(await this.get(slug))) return false;
    // One transaction so a crash can't leave a project half-deleted. Retrieval indexes are keyed
    // by scope, so drop them here too: the per-entity remove() methods that normally clean the
    // FTS/vector rows are bypassed by these bulk deletes.
    await this.store.tx(async () => {
      await this.store.run('DELETE FROM memory WHERE category = ?', [slug]);
      await this.store.run('DELETE FROM docs WHERE scope = ?', [slug]); // cascades doc_versions
      await this.store.run('DELETE FROM sessions WHERE scope = ?', [slug]); // cascades messages
      await this.store.run('DELETE FROM doc_chunks WHERE scope = ?', [slug]);
      await this.store.run('DELETE FROM memory_fts WHERE scope = ?', [slug]);
      await this.store.run('DELETE FROM chunk_fts WHERE scope = ?', [slug]);
      await this.store.run('DELETE FROM message_fts WHERE scope = ?', [slug]);
      await this.store.run('DELETE FROM embeddings WHERE scope = ?', [slug]);
      await this.store.run('DELETE FROM projects WHERE slug = ?', [slug]);
    });
    return true;
  }
}
