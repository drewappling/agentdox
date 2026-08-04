import type { Principal, Role } from '@agentdox/types';
import { roleAtLeast } from '@agentdox/types';

const VALID_ROLES: Role[] = ['none', 'read', 'write', 'admin'];

/**
 * Parse grant claims (space-delimited `scope:role` pairs, e.g. `ashlands:write demo:read`)
 * into a `Record<scope, role>`. Also accepts an already-object claim.
 */
export function parseScopeGrants(value: unknown): Record<string, Role> {
  const out: Record<string, Role> = {};
  if (!value) return out;
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if ((VALID_ROLES as string[]).includes(String(v))) out[k] = v as Role;
    }
    return out;
  }
  const str = String(value);
  for (const token of str.split(/\s+/)) {
    if (!token) continue;
    const [scope, maybeRole] = token.split(':');
    if (!scope) continue;
    const role = maybeRole && (VALID_ROLES as string[]).includes(maybeRole) ? (maybeRole as Role) : 'write';
    out[scope] = role;
  }
  return out;
}

/**
 * Does the principal hold at least `required` role on `scope`?
 * `*` grants (e.g. local/admin or a wildcard issuer claim) satisfy any scope.
 */
export function authorize(principal: Principal | undefined, scope: string, required: Role): boolean {
  if (!principal) return false;
  const grant = principal.grants[scope] ?? principal.grants['*'] ?? 'none';
  return roleAtLeast(grant, required);
}

/** Principal used when auth is disabled (local single-user): full access to every scope. */
export function localPrincipal(sub = 'local'): Principal {
  return { sub, kind: 'local', grants: { '*': 'admin' } };
}
