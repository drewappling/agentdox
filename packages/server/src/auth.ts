import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ChainAuthProvider,
  OidcAuthProvider,
  PatAuthProvider,
  authorize,
  localPrincipal,
  type AuthProvider,
} from '@agentdox/auth';
import type { Principal, Role } from '@agentdox/types';
import type { PatService } from '@agentdox/core';

export interface AuthContext {
  /** Whether bearer-token auth is enforced. */
  enabled: boolean;
  /** Chain of token verifiers (PAT, OIDC...). */
  chain: ChainAuthProvider | null;
  /** Local PAT service, for issuing/revoking tokens. Persists as long as the dox instance. */
  pat: PatService | null;
}

/** Build the auth context from environment configuration. */
export async function loadAuthContext(pat: PatService | null, env: NodeJS.ProcessEnv = process.env): Promise<AuthContext> {
  const enabled = env.AGENTDOX_AUTH_ENABLED === 'true';
  if (!enabled) return { enabled: false, chain: null, pat: null };

  const providers: AuthProvider[] = [];
  if (pat) providers.push(new PatAuthProvider(pat));

  const issuer = env.AGENTDOX_OIDC_ISSUER;
  if (issuer) {
    providers.push(
      await OidcAuthProvider.create({
        issuer,
        audience: env.AGENTDOX_OIDC_AUDIENCE || undefined,
        scopeClaim: env.AGENTDOX_OIDC_SCOPE_CLAIM || undefined,
      }),
    );
  }

  if (providers.length === 0) {
    throw new Error('AGENTDOX_AUTH_ENABLED=true but no providers configured (set AGENTDOX_OIDC_ISSUER)');
  }
  return { enabled: true, chain: new ChainAuthProvider(providers), pat };
}

/** Extract the bearer token from a request, or null. */
function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

/** Resolve the request's principal (global 401 if auth is enabled and the token is bad). */
export async function authenticate(req: FastifyRequest, auth: AuthContext): Promise<Principal | null> {
  if (!auth.enabled) return localPrincipal();
  const token = bearerToken(req);
  if (!token) return null;
  const result = await auth.chain!.verify(token);
  return result.ok ? result.principal : null;
}

/**
 * Guard helper: send 401/403 when authorization fails. Returns `true` if the request may proceed.
 * `scope` omitted = any authenticated caller. `role` defaults to 'read'.
 */
export function guard(
  req: FastifyRequest,
  reply: FastifyReply,
  auth: AuthContext,
  principal: Principal | null,
  scope?: string,
  role: Role = 'read',
): boolean {
  if (!auth.enabled) return true; // local single-user
  if (!principal) {
    void reply.code(401).send({ error: 'unauthorized', message: 'valid bearer token required' });
    return false;
  }
  if (scope !== undefined && !authorize(principal, scope, role)) {
    void reply.code(403).send({ error: 'forbidden', message: `no ${role} access to scope "${scope}"` });
    return false;
  }
  return true;
}
