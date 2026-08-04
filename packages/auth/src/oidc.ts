import type { JWTPayload } from 'jose';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Principal, Role } from '@agentdox/types';
import type { AuthProvider, VerifiedResult } from './providers.js';
import { parseScopeGrants } from './rbac.js';

export interface OidcAuthProviderOptions {
  /** OIDC issuer base URL, e.g. https://auth.example.com/realms/agentdox */
  issuer: string;
  /** Optional audience required on access tokens. */
  audience?: string;
  /**
   * Claim that carries space-delimited `scope:role` grants, e.g. `ashlands:write demo:read`.
   * Defaults to `agentdox:scopes`.
   */
  scopeClaim?: string;
  /** Optional custom mapping from arbitrary token claims to scope grants. */
  extractGrants?: (payload: JWTPayload) => Record<string, Role>;
  /** Custom fetcher (injectable for tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface DiscoveryDoc {
  jwks_uri: string;
  issuer?: string;
}

/** Validates access tokens from any compliant OIDC issuer via JWKS. IdP-agnostic. */
export class OidcAuthProvider implements AuthProvider {
  readonly name = 'oidc';
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly scopeClaim: string;
  private readonly issuer: string;
  private readonly audience?: string;
  private readonly extractGrants?: OidcAuthProviderOptions['extractGrants'];

  private constructor(opts: OidcAuthProviderOptions, jwksUri: string) {
    this.issuer = opts.issuer;
    this.audience = opts.audience;
    this.scopeClaim = opts.scopeClaim ?? 'agentdox:scopes';
    this.extractGrants = opts.extractGrants;
    this.jwks = createRemoteJWKSet(new URL(jwksUri));
  }

  /** Perform OIDC discovery (RFC 8414) and construct a provider bound to the issuer's JWKS. */
  static async create(opts: OidcAuthProviderOptions): Promise<OidcAuthProvider> {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const discoveryUrl = `${opts.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    const res = await fetchImpl(discoveryUrl);
    if (!res.ok) {
      throw new Error(`OIDC discovery failed (${res.status}) for ${discoveryUrl}`);
    }
    const discovery = (await res.json()) as DiscoveryDoc;
    if (!discovery.jwks_uri) throw new Error(`OIDC discovery missing jwks_uri for ${opts.issuer}`);
    return new OidcAuthProvider(opts, discovery.jwks_uri);
  }

  async verify(token: string): Promise<VerifiedResult> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        ...(this.audience ? { audience: this.audience } : {}),
      });
      const grants = this.extractGrants
        ? this.extractGrants(payload)
        : parseScopeGrants(payload[this.scopeClaim]);
      const principal: Principal = {
        sub: String(payload.sub ?? ''),
        name: typeof payload.name === 'string' ? payload.name : undefined,
        email: typeof payload.email === 'string' ? payload.email : undefined,
        kind: 'oidc',
        grants,
      };
      return { ok: true, principal, method: 'oidc' };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  }
}
