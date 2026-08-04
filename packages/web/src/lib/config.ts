// Runtime configuration. Override via Vite env (VITE_*) at build/dev time.
export const config = {
  apiBase: (import.meta.env.VITE_API as string | undefined) ?? 'http://localhost:3003',
  oidcIssuer: (import.meta.env.VITE_OIDC_ISSUER as string | undefined) ?? 'http://localhost:8080/realms/agentdox',
  oidcClientId: (import.meta.env.VITE_OIDC_CLIENT_ID as string | undefined) ?? 'agentdox-web',
  get redirectUri(): string {
    return window.location.origin + window.location.pathname;
  },
};
