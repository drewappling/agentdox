# agentdox Authentication & Authorization Architecture

**Status:** Design (v0.1)
**Scope:** REST API · Web UI · SDK · MCP
**Guiding principle:** *agentdox is IdP-agnostic — bring your own OpenID Connect provider.*

---

## 1. Goals & Non-Goals

### Goals
1. **IdP-agnostic.** Any compliant OIDC/OpenID Connect provider works (Keycloak, Authentik,
   Zitadel, Okta, Auth0, Microsoft Entra ID, AWS Cognito, ADFS). No vendor coupling.
2. **Three credential classes** with the right flow for each:
   - Humans in a browser → Authorization Code + PKCE.
   - Services / SDK / cron / agents → OIDC **client-credentials** and/or **Personal Access Tokens**.
   - MCP over HTTP → the **MCP OAuth 2.1** authorization spec (when we add the HTTP transport).
3. **Stateless verification.** API validates JWTs via **JWKS**; horizontal-scale friendly; no
   shared session store for API traffic.
4. **Scope-based RBAC.** Map IdP groups/roles → agentdox project `scope` permissions.
5. **Extensible seam.** An `AuthProvider` interface so non-OIDC identity (SAML, LDAP bridge,
   local users) can be added without touching core.
6. **Local-first stays frictionless.** Single-user localhost installs can run with auth disabled.

### Non-Goals (this iteration)
- Full multi-tenant SaaS billing / quota enforcement.
- Admin console UI for user management (IdPs do this).
- SAML / LDAP providers (surface as `AuthProvider` implementations later).

---

## 2. Surfaces & Their Requirements

| Surface | Client | Flow | Token | Notes |
|---|---|---|---|---|
| Web UI | Browser (SPA) | Auth Code + **PKCE** | opaque session / ID token | Never exposes client secret |
| REST API | Users, SDK, services | Bearer **access token** (JWT) | stateless JWT | validated via JWKS |
| SDK / cron / CI / agents | Machine | **client-credentials** or **PAT** | service token / PAT | non-interactive |
| MCP (stdio) | Agent on same host | *none* | env/config | OS is the trust boundary |
| MCP (HTTP, later) | Remote agent | **MCP OAuth 2.1** | OAuth access token | dynamic client registration |

> **MCP note:** the current stdio transport needs **no auth** — it is a local process talking to
> a local SQLite file; the OS enforces who can run it. OIDC for MCP only applies to a future
> **streamable HTTP transport** to a remote agentdox, and must follow the MCP authorization spec.

---

## 3. Principle: IdP-Agnostic Core

agentdox holds **no assumption about which provider issued the token.** It is configured by
pointing at any issuer:

```env
AGENTDOX_AUTH_ENABLED=true
AGENTDOX_OIDC_ISSUER=https://auth.example.com/realms/agentdox   # discovery endpoint base
AGENTDOX_OIDC_CLIENT_ID=agentdox
AGENTDOX_OIDC_CLIENT_SECRET=…            # confidential client (web UI / machine)
AGENTDOX_OIDC_SCOPES=openid email profile agentdox:scopes
```

At startup the server fetches **OIDC discovery** (`/.well-known/openid-configuration`, RFC 8414)
and caches **JWKS**. Every access token is validated against that, generically. Switching from
Keycloak to Entra ID is a **config change, not a code change.**

---

## 4. Authentication Flows

### 4.1 Human — Web UI (`Authorization Code + PKCE`)  ✅ v1
1. SPA redirects to `authorization_endpoint` with `code_challenge` (S256) + `code_challenge_method`.
2. IdP authenticates the user, redirects back with an auth `code`.
3. Backend exchanges `code` + `code_verifier` + `client_secret` at `token_endpoint`.
4. Backend mints an **opaque session** (httpOnly, Secure, SameSite=Lax cookie); the client
   never holds secrets. `created = true`.
5. SPA uses the session for browser requests; API surface for interactive calls goes through the
   session, not raw JWTs in `localStorage`.

### 4.2 Machine — SDK / cron / CI / agents  ✅ v1
- **OIDC client-credentials:** the machine presents `client_id` + `client_secret` (or signed JWT
  for the private-key-jwt flow) at `token_endpoint` → `access_token`.
- **Personal Access Token:** a long-lived opaque token minted by agentdox, stored hashed
  (SHA-256) in the DB, revoked by the user. The pragmatic path for simple self-hosted setups that
  don't want to configure a service account in the IdP.
- SDK sends it as `Authorization: Bearer <token>`; no interactive login.

### 4.3 MCP over HTTP (future)  ⏳ v1.1+
Follow the **MCP Authorization spec** (OAuth 2.1 + PKCE + dynamic client registration, RFC 7591):

- MCP server URL is the protected-resource `resource` parameter.
- Agent clients can dynamically register, or use a pre-registered client.
- Tokens are validated the same way as any other access token.

---

## 5. Token Validation (JWKS)

**Stateless, provider-agnostic.**

1. Parse `Authorization: Bearer <token>`.
2. Verify **signature** against the issuer's cached JWKS (RS256/ES256).
3. Assert `exp`, `iss` (matches configured issuer), `aud` (matches a configured audience),
   `nonce` where applicable.
4. Extract identity `sub` (stable subject) and authorization claims (below).
5. Reject on any failure with `401`; JWKS cache is refreshed on expiry/rotation.

No per-request IdP round-trip; no distributed session store required for API traffic.

---

## 6. Authorization: Claims → Scopes (RBAC)

agentdox's natural authorization unit is its existing **`scope`** — a project/agent namespace
(e.g. `ashlands`, `demo`). Authorization answers: *may this caller read/write this scope?*

**Model — resolves to an `authorizedScopes` set per request:**

- **Source A: OIDC claims.** Access tokens carry scopes/groups. Default mapping:
  - scope claim `agentdox:scopes` (custom, space-delimited) → e.g. `ashlands read`, `~ write`.
  - provider groups/roles mapped through config (`agentdox.groupMapping`).
- **Source B: local overrides.** An `acls` table mapping `subject` (or group) → scope+role, for
  setups that don't want to manage roles in the IdP.
- The union of A and B is the effective `authorizedScopes`.

**Role model (per scope):** `none | read | write | admin` (admin = manage ACLs + evict).

**Enforcement** is centralized in one middleware that both the REST router and the (future)
MCP HTTP transport call, so authorization logic never drifts between surfaces.

When auth is **disabled** (local single-user), all scopes are `write` for the local caller.

---

## 7. The Extensibility Seam: `AuthProvider`

```ts
interface AuthProvider {
  name: 'oidc' | 'saml' | 'local' | ...;
  discovery(): Promise<ProviderConfig>;
  authenticate(interactive?: Context): Promise<AuthResult>;   // browser flows
  verify(token: string): Promise<VerifiedPrincipal>;          // API / SDK / MCP
  authorize(principal, scope): Promise<Role>;                 // RBAC resolution
}
```

- Ships with **`OidcAuthProvider`** (the implementation of every flow above).
- Enterprise additions land as new implementations of this interface — e.g. **SAML (Entra/Okta/
  ADFS)**, an **LDAP bridge**, or a **local-user** provider for air-gapped installs — without
  touching validation, RBAC, or the API surface.
- This is the contract that makes agentdox future-proof against IdP churn.

---

## 8. Configuration Reference

```env
# Master switch — local single-user can run with auth off.
AGENTDOX_AUTH_ENABLED=false

# OIDC provider (any compliant issuer)
AGENTDOX_OIDC_ISSUER=
AGENTDOX_OIDC_CLIENT_ID=
AGENTDOX_OIDC_CLIENT_SECRET=
AGENTDOX_OIDC_SCOPES=openid email profile agentdox:scopes
AGENTDOX_OIDC_AUDIENCE=            # optional; if omitted, accept issuer's default aud
AGENTDOX_OIDC_GROUP_MAPPING=groups:agentdox_roles   # JSON or colon syntax

# Storage / deployment
AGENTDOX_DB_URL=sqlite:./data/agentdox.db   # or postgres://… for enterprise
AGENTDOX_PUBLIC_URL=https://dox.example.com # for redirect URIs + MCP resource
AGENTDOX_COOKIE_SECURE=true
```

---

## 9. Deployment Reference (NAS / Docker)

The full deploy runs adjacent to your self-hosted Bitwarden on the NAS:

- **IdP:** Keycloak (reference, Apache-2.0) — or Authentik/Zitadel/Entra; config-only swap.
- **app:** `agentdox` server + web UI container.
- **proxy:** Traefik / Caddy / Nginx Proxy Manager on the NAS terminates TLS for
  `dox.example.com` and `auth.example.com`; OIDC redirect URIs are stable public URLs.
- **bootstrap:** a compose profile that creates the agentdox OIDC client, a service account, and
  a demo project scope — so the first `docker compose up` is already logged-in and useful.

See PR in `deploy/docker-compose.yml` (next).

---

## 10. Enterprise Roadmap

- **v1.0 (now):**
  - `OidcAuthProvider` + `AuthProvider` interface.
  - Human PKCE login on Web UI; JWT/JWKS validation on REST.
  - Client-credentials + PATs for SDK/cron/agents.
  - Claims→scope RBAC middleware + `acls` overrides.
  - **Postgres** storage backend (enterprise), keeping SQLite for small installs.
- **v1.1:**
  - MCP **HTTP transport** with **MCP OAuth 2.1** + dynamic registration.
  - IdP **group/role** sync into `acls` (scheduled diff).
- **v1.2+:**
  - **SAML** `AuthProvider` for legacy enterprise stacks.
  - **LDAP** bridge `AuthProvider`.
  - Audit log of auth/authorization decisions (who accessed which scope when).
  - Per-scope **quota / eviction policy** surfaced to admins.

---

## 11. Threat Model (abridged)

| Threat | Mitigation |
|---|---|
| Token replay | Stateless JWT exp + short lifetimes; refresh rotation; PATs hashed at rest |
| XSS stealing session | httpOnly + Secure + SameSite cookies; no JWTs in `localStorage` |
| CSRF on browser flows | PKCE + state + SameSite=Lax cookies |
| Open redirect in OIDC callback | Strict redirect-URI allowlist = configured public URLs |
| Over-privileged machine token | Per-service PATs scoped to specific `authorizedScopes` |
| Localhost exposure | Auth disabled only on loopback; `AGENTDOX_AUTH_ENABLED` required for non-loopback bind |
| IdP compromise | Optional audience pinning; rotate JWKS cache on fetch failure |

---

## 12. Open Questions
- Which bearer-token lifetime / refresh policy should SDK client-credential tokens default to?
- Should PATs carry an expiry and per-scope ACLs on creation (recommended), or just a global scope?
- Role inheritance (`admin ⊃ write ⊃ read`) vs. explicit per-scope grants — recommend inheritance
  for v1, revisit for complex multi-tenant.
- Should the MCP HTTP transport share the REST middleware for RBAC (recommended) or keep a
  separate policy?

---

## 13. Implementation Status

Implemented and **verified** (see `scripts/test-auth.mjs` — 13 checks — and
`scripts/test-server-auth.mjs` — 10 E2E HTTP checks; run with `npm run test:auth` /
`npm run test:server-auth`):

- **`@agentdox/auth`** package: `AuthProvider` interface, `OidcAuthProvider` (JWKS +
  discovery validation, idP-agnostic), `PatAuthProvider`, `ChainAuthProvider`, RBAC helpers
  (`parseScopeGrants`, `authorize`, `localPrincipal`).
- **`@agentdox/core`**: `PatService` — issue (SHA-256 hashed at rest), sync/async lookup,
  revoke, list; `pat` table.
- **Server**: bearer-token auth on all routes via `guard()` (401 unauth / 403 bad scope);
  scope RBAC against a per-request principal; PAT endpoints (`GET/POST /auth/tokens`,
  `DELETE /auth/tokens/:id`); `AGENTDOX_ADMIN_TOKEN` bootstrap; env-config driven
  (`AGENTDOX_AUTH_ENABLED`, `AGENTDOX_OIDC_*`). Verified: 401 on no token, wildcard-admin
  access, read-only PAT denied write (403), scope isolation (403 on unrelated scope),
  filtered list views, revocation.
- Types (`Role`, `Principal`, `roleAtLeast`, `ROLE_ORDER`) live in `@agentdox/types` so the
  SDK and MCP can share them.

**Not yet implemented** (roadmap, per §10): human Authorization-Code+PKCE web-UI login
(needs the web app), OIDC client-credentials token endpoint for SDK/automation, MCP HTTP
transport with the MCP OAuth 2.1 spec, and IdP group→scope role sync.

