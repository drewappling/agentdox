// In-network OIDC round-trip via client_credentials (service account).
// Run inside agentdox-server:  node /tmp/oidc-smoke.mjs
// Proves: Keycloak JWT -> agentdox JWKS validation -> scope RBAC.
const KC = 'http://keycloak:8080/realms/agentdox';
const DOX = 'http://127.0.0.1:3003';

(async () => {
  const tr = await fetch(`${KC}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&client_id=agentdox-server&client_secret=agentdox-server-dev-secret',
  });
  const tj = await tr.json();
  if (!tj.access_token) throw new Error('client_credentials failed: ' + JSON.stringify(tj));
  const at = tj.access_token;
  const p = JSON.parse(Buffer.from(at.split('.')[1], 'base64url').toString());
  console.log('token iss        :', p.iss);
  console.log('agentdox:scopes  :', JSON.stringify(p['agentdox:scopes']));

  const readDemo = await fetch(`${DOX}/memory?category=demo`, { headers: { authorization: `Bearer ${at}` } });
  console.log('GET /memory?category=demo  (write grant)      ->', readDemo.status, '(expect 200)');

  const writeAsh = await fetch(`${DOX}/memory`, {
    method: 'POST',
    headers: { authorization: `Bearer ${at}`, 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'oidc smoke', category: 'ashlands' }),
  });
  console.log('POST /memory category=ashlands (read-only)    ->', writeAsh.status, '(expect 403)');

  const appMiss = await fetch(`${DOX}/memory?category=missing`); // scope not in grants
  console.log('GET /memory?category=missing (no grant)      ->', appMiss.status, '(expect 403)');

  const noAuth = await fetch(`${DOX}/memory`);
  console.log('GET /memory (no token)                       ->', noAuth.status, '(expect 401)');

  const all = await fetch(`${DOX}/memory`, { headers: { authorization: `Bearer ${at}` } });
  const arr = await all.json().catch(() => []);
  console.log('GET /memory (all, filtered)                  ->', all.status, 'visible categories:', [...new Set(arr.map((e) => e.category))]);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
