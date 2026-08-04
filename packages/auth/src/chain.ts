import type { AuthProvider, VerifiedResult } from './providers.js';

/** Tries each enabled provider in order; returns the first that verifies the token. */
export class ChainAuthProvider implements AuthProvider {
  readonly name = 'chain';

  constructor(private readonly providers: AuthProvider[]) {}

  async verify(token: string): Promise<VerifiedResult> {
    if (!token) return { ok: false, reason: 'missing bearer token' };
    for (const provider of this.providers) {
      const result = await provider.verify(token);
      if (result.ok) return result;
    }
    return { ok: false, reason: 'unauthorized: token rejected by all providers' };
  }
}
