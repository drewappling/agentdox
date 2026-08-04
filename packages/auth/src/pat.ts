import { createHash, randomBytes } from 'node:crypto';
import type { Principal, Role } from '@agentdox/types';
import type { AuthProvider, VerifiedResult } from './providers.js';

/** A stored PAT record — always persisted as a hash, never the raw token. */
export interface PatRecord {
  sub: string;
  name?: string;
  grants: Record<string, Role>;
  /** ms epoch after which the token is invalid. */
  expiresAt?: number | null;
}

/** Storage read side the PAT provider needs. The writer lives in core's PatService. */
export interface PatStore {
  findByHash(hash: string): Promise<PatRecord | null>;
}

/** Hash a raw token for storage/lookup. Tokens are stored hashed, never in plaintext. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Generate a cryptographically-random opaque token. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Verifies Personal Access Tokens against a PatStore (lookup by SHA-256). */
export class PatAuthProvider implements AuthProvider {
  readonly name = 'pat';

  constructor(private readonly store: PatStore) {}

  async verify(token: string): Promise<VerifiedResult> {
    if (!token) return { ok: false, reason: 'missing token' };
    const record = await this.store.findByHash(hashToken(token));
    if (!record) return { ok: false, reason: 'invalid token' };
    if (record.expiresAt && record.expiresAt < Date.now()) return { ok: false, reason: 'token expired' };
    const principal: Principal = {
      sub: record.sub,
      name: record.name,
      kind: 'pat',
      grants: record.grants,
    };
    return { ok: true, principal, method: 'pat' };
  }
}
