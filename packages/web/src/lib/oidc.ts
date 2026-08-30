import { config } from './config';

const b64url = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const sha256 = async (s: string): Promise<ArrayBuffer> =>
  crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));

/** Start the Authorization Code + PKCE flow against the configured OIDC issuer. */
export async function startLogin(): Promise<void> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await sha256(verifier));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem('agentdox:pkce_verifier', verifier);
  sessionStorage.setItem('agentdox:oidc_state', state);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.oidcClientId,
    redirect_uri: config.redirectUri,
    scope: 'openid agentdox',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  window.location.href = `${config.oidcIssuer}/protocol/openid-connect/auth?${params.toString()}`;
}

/** If the current URL carries an auth code, verify state + exchange it for an access token. */
export async function handleLoginRedirect(): Promise<string | null> {
  const url = new URL(window.location.href);
  const oidcError = url.searchParams.get('error');
  if (oidcError) {
    const desc = url.searchParams.get('error_description');
    window.history.replaceState({}, '', url.origin + url.pathname);
    throw new Error(`OIDC login failed: ${desc ?? oidcError}`);
  }
  const code = url.searchParams.get('code');
  if (!code) return null;

  // Reject a crafted/cross-site redirect: the state must match what we started with.
  const expected = sessionStorage.getItem('agentdox:oidc_state');
  if (!expected || url.searchParams.get('state') !== expected) {
    throw new Error('OIDC state mismatch — login aborted');
  }

  const verifier = sessionStorage.getItem('agentdox:pkce_verifier');
  // one-time use — clear both regardless of outcome
  sessionStorage.removeItem('agentdox:pkce_verifier');
  sessionStorage.removeItem('agentdox:oidc_state');
  if (!verifier) throw new Error('PKCE verifier missing (session storage was cleared) — please retry login');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.oidcClientId,
    code,
    redirect_uri: config.redirectUri,
    code_verifier: verifier,
  });
  const res = await fetch(`${config.oidcIssuer}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const j = (await res.json()) as { access_token?: string; error_description?: string };
  if (!res.ok || !j.access_token) throw new Error(j.error_description ?? 'OIDC token exchange failed');
  // strip the ?code&state from the URL and return to a clean hash route
  window.history.replaceState({}, '', url.origin + url.pathname);
  return j.access_token;
}
