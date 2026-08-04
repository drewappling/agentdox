import type { Role } from '@agentdox/types';
import { generateToken, hashToken, type PatRecord, type PatStore } from '@agentdox/auth';
import type { Store } from './db.js';
import { newId, nowIso } from './util.js';

interface Row {
  id: string;
  token_hash: string;
  sub: string;
  name: string | null;
  grants_json: string;
  created_at: string;
  expires_at: number | null;
  revoked: number;
}

export interface PatSummary {
  id: string;
  name?: string;
  sub: string;
  createdAt: string;
  expiresAt?: number | null;
  revoked: boolean;
}

/** Issues, stores (hashed), lists, and revokes Personal Access Tokens. */
export class PatService implements PatStore {
  constructor(private readonly store: Store) {}

  /**
   * Issue a new PAT. The raw token is returned exactly once; only its SHA-256 hash is stored.
   * `grants` maps an agentdox scope -> role. Use `*` for wildcard/admin.
   */
  issue(opts: { name?: string; grants: Record<string, Role>; ttlMs?: number; rawToken?: string }): { id: string; token: string; expiresAt?: number | null } {
    const id = newId('pat');
    const token = opts.rawToken ?? generateToken();
    const expiresAt = opts.ttlMs ? Date.now() + opts.ttlMs : null;
    this.store.db
      .prepare(
        `INSERT INTO pat (id, token_hash, sub, name, grants_json, created_at, expires_at, revoked)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        id,
        hashToken(token),
        '__admin__',
        opts.name ?? null,
        JSON.stringify(opts.grants),
        nowIso(),
        expiresAt,
      );
    return { id, token, expiresAt };
  }

  /** True if a PAT with this raw token already exists (sync; used for idempotent bootstrap). */
  existsByRawToken(rawToken: string): boolean {
    return !!this.store.db.prepare('SELECT 1 FROM pat WHERE token_hash = ?').get(hashToken(rawToken));
  }

  async findByHash(hash: string): Promise<PatRecord | null> {
    const row = this.store.db
      .prepare('SELECT * FROM pat WHERE token_hash = ? AND revoked = 0')
      .get(hash) as Row | undefined;
    if (!row) return null;
    if (row.expires_at && row.expires_at < Date.now()) return null;
    const grants: Record<string, Role> = {};
    try {
      const parsed = JSON.parse(row.grants_json) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string') grants[k] = v as Role;
        }
      }
    } catch {
      /* malformed grants -> empty */
    }
    return {
      sub: row.sub,
      name: row.name ?? undefined,
      grants,
      expiresAt: row.expires_at,
    };
  }

  /** Rounds a raw bearer into a record via findByHash(hash(token)). */
  async findRaw(rawToken: string): Promise<PatRecord | null> {
    return this.findByHash(hashToken(rawToken));
  }

  revoke(id: string): boolean {
    const res = this.store.db.prepare('UPDATE pat SET revoked = 1 WHERE id = ?').run(id);
    return res.changes > 0;
  }

  list(): PatSummary[] {
    const rows = this.store.db.prepare('SELECT * FROM pat ORDER BY created_at DESC').all() as unknown as Row[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name ?? undefined,
      sub: r.sub,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      revoked: r.revoked === 1,
    }));
  }
}
