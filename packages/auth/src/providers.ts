import type { Principal } from '@agentdox/types';

/** Outcome of attempting to verify a bearer token against one auth provider. */
export type VerifiedResult =
  | { ok: true; principal: Principal; method: string }
  | { ok: false; reason?: string };

/** A strategy that can verify a raw bearer token into a principal. */
export interface AuthProvider {
  readonly name: string;
  verify(token: string): Promise<VerifiedResult>;
}
