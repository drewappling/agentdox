// End-to-end: real Keycloak user (password grant) -> agentdox JWKS validation -> scope RBAC.
// Run inside the agentdox-server container:  node /tmp/oidc-smoke.mjs
const KC = 'http://keycloak:8080/realms/agentdox';
const DOX = 'http://127.0.0.1:3003';

(async () => {
  const tr = await fetch(`${KC}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=password&client_id=agentdox-server&client_secret=agentdox-server-dev-secret&username=alice&password=demo123',
  });
  const tj = await tr.json();
  if (!tj.access_token) throw new Error('password grant failed: ' + JSON.stringify(tj));
  const at = tj.access_token;
  const p = JSON.parse(Buffer.from(at.split('.')[1], 'base64url').toString());
  console.log('user token issuer :', p.iss, '| sub:', p.sub);
  console.log('agentdox:scopes  :', p['agentdox:scopes']);

  const readDemo = await fetch(`${DOX}/memory?category=demo`, { headers: { authorization: `Bearer ${at}` } });
  console.log('GET /memory?category=demo   (write grant)     ->', readDemo.status, '(expect 200)');

  const writeAsh = await fetch(`${DOX}/memory`, {
    method: 'POST',
    headers: { authorization: `Bearer ${at}`, 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'e2e oidc', category: 'acme' }),
  });
  console.log('POST /memory category=acme (read-only)    ->', writeAsh.status, '(expect 403)');

  const ctx = await fetch(`${DOX}/context/assemble`, {
    method: 'POST',
    headers: { authorization: `Bearer ${at}`, 'content-type': 'application/json' },
    body: JSON.stringify({ scope: 'demo' }),
  });
  console.log('POST /context/assemble scope=demo (read)      ->', ctx.status, '(expect 200)');

  const noAuth = await fetch(`${DOX}/memory`);
  console.log('GET /memory (no token)                        ->', noAuth.status, '(expect 401)');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
