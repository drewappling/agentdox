// Runtime configuration. Override via Vite env (VITE_*) at build/dev time.
export const config = {
  // Dev uses the Vite /api proxy (same-origin, no CORS); production defaults to same-origin '',
  // so a build that forgets VITE_API talks to its own host rather than silently to localhost.
  apiBase: (import.meta.env.VITE_API as string | undefined) ?? (import.meta.env.DEV ? '/api' : ''),
  oidcIssuer: (import.meta.env.VITE_OIDC_ISSUER as string | undefined) ?? (import.meta.env.DEV ? 'http://localhost:8090/realms/agentdox' : ''),
  oidcClientId: (import.meta.env.VITE_OIDC_CLIENT_ID as string | undefined) ?? 'agentdox-web',
  get redirectUri(): string {
    return window.location.origin + window.location.pathname;
  },
};
