// End-to-end HTTP auth test: boots a real server with auth enabled (PAT-only provider +
// admin bootstrap), then exercises 401 / RBAC allow-deny / PAT minting through the REST API.
import { rmSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import { startServer } from '../packages/server/dist/index.js';

const ADMIN = 'admin-secret-xyz';
const dbPath = 'data/test-server-auth.db';
for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) rmSync(f, { force: true });
mkdirSync('data', { recursive: true });

const { port } = await startServer({
  port: 0,
  dbPath,
  authEnabled: true,
  env: { AGENTDOX_AUTH_ENABLED: 'true', AGENTDOX_ADMIN_TOKEN: ADMIN },
});
const base = `http://127.0.0.1:${port}`;

const PASS = [];
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); PASS.push(cond); };

/** Minimal HTTP request helper (node:http, bypasses any proxy env). */
function req(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(base + path, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const get = (p, token) => req('GET', p, { token });
const post = (p, token, body) => req('POST', p, { token, body });
const del = (p, token) => req('DELETE', p, { token });

// health is public
let r = await get('/health');
check('health is public (no token)', r.status === 200);

// unauthenticated access blocked
r = await get('/memory');
check('GET /memory without token -> 401', r.status === 401);

// admin token works everywhere
r = await get('/memory', ADMIN);
check('admin token read /memory -> 200', r.status === 200);

// mint a read-only PAT for scope 'demo'
r = await post('/auth/tokens', ADMIN, { name: 'demo-reader', grants: { demo: 'read' } });
check('admin mints a read-only demo PAT', r.status === 200);
const demo = (await r).body.token;

// demo-reader can read scope demo
r = await get('/docs?scope=demo', demo);
check('demo reader can read scope=demo -> 200', r.status === 200);

// demo-reader (read only) cannot write to demo scope
r = await post('/memory', demo, { content: 'x', category: 'demo' });
check('demo reader denied write to demo -> 403', r.status === 403);

// demo reader cannot reach a scope it lacks (acme)
r = await post('/context/assemble', demo, { scope: 'acme' });
check('demo reader denied unrelated scope -> 403', r.status === 403);

// admin can write anywhere
r = await post('/memory', ADMIN, { content: 'admin wrote this', category: 'demo', importance: 0.9 });
check('admin can write memory -> 200', r.status === 200);

// demo reader listing all memory is filtered to its readable scopes
r = await get('/memory', demo);
const memSince = r.body;
check('demo reader list filtered to readable scope', Array.isArray(memSince) && memSince.every((e) => e.category === 'demo'));

// admin can mint + revoke
r = await post('/auth/tokens', ADMIN, { grants: { '*': 'admin' } });
const second = await r.body;
r = await del(`/auth/tokens/${second.id}`, ADMIN);
check('admin revokes PAT', r.status === 200);

// ---- Regression: unscoped list/search must not leak across scopes (CWE-862 / CWE-306) ----
// Seed matching content in two scopes; the demo-reader may only read `demo`.
await post('/docs', ADMIN, { slug: 'acme-doc', title: 'Acme doc', content: 'acme secret content', scope: 'acme' });
await post('/docs', ADMIN, { slug: 'demo-doc', title: 'Demo doc', content: 'demo secret content', scope: 'demo' });
await post('/sessions', ADMIN, { scope: 'acme', title: 'acme session' });
await post('/sessions', ADMIN, { scope: 'demo', title: 'demo session' });
await post('/memory', ADMIN, { content: 'acme secret memory', category: 'acme', importance: 0.9 });
await post('/memory', ADMIN, { content: 'demo secret memory', category: 'demo', importance: 0.9 });

// Unauthenticated callers get nothing from the unscoped routes (these used to return every scope).
for (const path of ['/docs', '/sessions', '/docs/search?q=secret', '/memory/search?q=secret', '/docs/passages?q=secret']) {
  const u = await get(path);
  check(`unauthenticated ${path} -> 401`, u.status === 401);
}

// A scope-limited reader without a scope filter sees only its readable scopes — never `acme`.
r = await get('/docs', demo);
check('unscoped /docs filtered to reader scope',
  Array.isArray(r.body) && r.body.some((d) => d.scope === 'demo') && !r.body.some((d) => d.scope === 'acme'));
r = await get('/sessions', demo);
check('unscoped /sessions filtered to reader scope',
  Array.isArray(r.body) && r.body.some((s) => s.scope === 'demo') && !r.body.some((s) => s.scope === 'acme'));
r = await get('/docs/search?q=secret', demo);
check('unscoped /docs/search filtered to reader scope',
  Array.isArray(r.body) && r.body.some((d) => d.scope === 'demo') && !r.body.some((d) => d.scope === 'acme'));
r = await get('/memory/search?q=secret', demo);
check('unscoped /memory/search filtered to reader scope',
  Array.isArray(r.body) && r.body.some((h) => h.entry.category === 'demo') && !r.body.some((h) => h.entry.category === 'acme'));

console.log(`\n${PASS.filter(Boolean).length}/${PASS.length} checks passed`);
process.exit(PASS.every(Boolean) ? 0 : 1);
