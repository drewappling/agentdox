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
  /** scope -> role; `*` is the wildcard. */
  grants: Record<string, Role>;
  createdAt: string;
  expiresAt?: number | null;
  revoked: boolean;
}

function parseGrants(json: string): Record<string, Role> {
  const grants: Record<string, Role> = {};
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') grants[k] = v as Role;
    }
  } catch {
    /* malformed grants -> empty */
  }
  return grants;
}

const expiry = (v: number | null): number | null => (v === null || v === undefined ? null : Number(v));

/** Issues, stores (hashed), lists, and revokes Personal Access Tokens. */
export class PatService implements PatStore {
  constructor(private readonly store: Store) {}

  /**
   * Issue a new PAT. The raw token is returned exactly once; only its SHA-256 hash is stored.
   * `grants` maps an agentdox scope -> role. Use `*` for wildcard/admin.
   */
  async issue(opts: { name?: string; grants: Record<string, Role>; ttlMs?: number; rawToken?: string }): Promise<{ id: string; token: string; expiresAt?: number | null }> {
    const id = newId('pat');
    const token = opts.rawToken ?? generateToken();
    const expiresAt = opts.ttlMs ? Date.now() + opts.ttlMs : null;
    await this.store.run(
      `INSERT INTO pat (id, token_hash, sub, name, grants_json, created_at, expires_at, revoked)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      [id, hashToken(token), '__admin__', opts.name ?? null, JSON.stringify(opts.grants), nowIso(), expiresAt],
    );
    return { id, token, expiresAt };
  }

  /** True if a PAT with this raw token already exists (used for idempotent bootstrap). */
  async existsByRawToken(rawToken: string): Promise<boolean> {
    return !!(await this.store.get('SELECT 1 AS one FROM pat WHERE token_hash = ?', [hashToken(rawToken)]));
  }

  async findByHash(hash: string): Promise<PatRecord | null> {
    const row = await this.store.get<Row>('SELECT * FROM pat WHERE token_hash = ? AND revoked = 0', [hash]);
    if (!row) return null;
    const expiresAt = expiry(row.expires_at);
    if (expiresAt && expiresAt < Date.now()) return null;
    return {
      sub: row.sub,
      name: row.name ?? undefined,
      grants: parseGrants(row.grants_json),
      expiresAt,
    };
  }

  /** Rounds a raw bearer into a record via findByHash(hash(token)). */
  async findRaw(rawToken: string): Promise<PatRecord | null> {
    return this.findByHash(hashToken(rawToken));
  }

  async revoke(id: string): Promise<boolean> {
    const res = await this.store.run('UPDATE pat SET revoked = 1 WHERE id = ?', [id]);
    return res.changes > 0;
  }

  async list(): Promise<PatSummary[]> {
    const rows = await this.store.all<Row>('SELECT * FROM pat ORDER BY created_at DESC');
    return rows.map((r) => ({
      id: r.id,
      name: r.name ?? undefined,
      sub: r.sub,
      grants: parseGrants(r.grants_json),
      createdAt: r.created_at,
      expiresAt: expiry(r.expires_at),
      revoked: Number(r.revoked) === 1,
    }));
  }
}
