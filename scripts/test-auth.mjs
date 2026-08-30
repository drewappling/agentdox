// Integration test for @agentdox/auth:
//  1) OidcAuthProvider validates tokens against a local mock OIDC issuer (discovery + JWKS).
//  2) PatAuthProvider roundtrips issued Personal Access Tokens (issue -> verify -> revoke).
import { createServer } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { AgentDox } from '@agentdox/core';
import { ChainAuthProvider, OidcAuthProvider, PatAuthProvider, authorize, localPrincipal } from '@agentdox/auth';

const PASS = [];
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) process.exitCode = 1;
  PASS.push(cond);
};

// ---------- 1) Mock OIDC issuer ----------
const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
const publicJwk = await exportJWK(publicKey);
const privateJwk = await exportJWK(privateKey);
const kid = 'test-key-1';
publicJwk.kid = kid; publicJwk.alg = 'RS256';
privateJwk.kid = kid; privateJwk.alg = 'RS256';
const jwks = { keys: [publicJwk] };

const oidc = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url.endsWith('/.well-known/openid-configuration')) {
    res.end(JSON.stringify({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks` }));
  } else if (req.url.endsWith('/jwks')) {
    res.end(JSON.stringify(jwks));
  } else {
    res.statusCode = 404; res.end('{}');
  }
});
await new Promise((r) => oidc.listen(0, '127.0.0.1', r));
const ISSUER = `http://127.0.0.1:${oidc.address().port}`;
const AUDIENCE = 'agentdox-web';

const sign = (claims = {}) =>
  new SignJWT({ name: 'Alice', email: 'alice@example.com', 'agentdox:scopes': 'demo:write acme:read', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setSubject('user-123')
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime('1h')
    .sign(privateKey);

const provider = await OidcAuthProvider.create({ issuer: ISSUER, audience: AUDIENCE });

// valid token
let good = await provider.verify(await sign());
check('OIDC: valid token accepted', good.ok && good.principal.sub === 'user-123' && good.principal.kind === 'oidc');
check('OIDC: grants parsed from scope claim', good.ok && good.principal.grants['demo'] === 'write' && good.principal.grants['acme'] === 'read');

// wrong issuer
let badIssuer = await provider.verify(
  await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid }).setSubject('x').setIssuer('https://evil.example').setAudience(AUDIENCE).setExpirationTime('1h').sign(privateKey),
);
check('OIDC: token from wrong issuer rejected', !badIssuer.ok);

// garbage token
check('OIDC: garbage token rejected', !(await provider.verify('not.a.jwt')).ok);

// chain with PAT
const patAuth = new PatAuthProvider({ findByHash: async () => null });
const chain = new ChainAuthProvider([patAuth, provider]);
const chained = await chain.verify(await sign());
check('OIDC: verified via chain', chained.ok);

// ---------- 2) PAT roundtrip ----------
const dbPath = 'data/test-auth.db';
rmSync(dbPath, { force: true });
mkdirSync('data', { recursive: true });
const dox = new AgentDox(dbPath);

const { id, token } = dox.pat.issue({ name: 'ci-bot', grants: { demo: 'write', '*': 'read' }, ttlMs: 3600_000 });
const patProvider = new PatAuthProvider(dox.pat);
const patOk = await patProvider.verify(token);
check('PAT: issued token verifies', patOk.ok && patOk.principal.grants['demo'] === 'write');
check('PAT: stored hashed (no plaintext in DB)', !dox.store.db.prepare('SELECT * FROM pat').all().some((r) => JSON.stringify(r).includes(token)));

check('PAT: wrong token rejected', !(await patProvider.verify('not-the-token')).ok);
dox.pat.revoke(id);
check('PAT: revoked token rejected', !(await patProvider.verify(token)).ok);

// ---------- 3) RBAC helpers ----------
const p = { sub: 'u', kind: 'oidc', grants: { demo: 'admin', other: 'read' } };
check('RBAC: admin on demo passes write/read/admin', authorize(p, 'demo', 'write') && authorize(p, 'demo', 'admin') && authorize(p, 'demo', 'read'));
check('RBAC: read on other blocks write', authorize(p, 'other', 'read') && !authorize(p, 'other', 'write'));
check('RBAC: no grant blocks on unknown scope', !authorize(p, 'nope', 'read'));
check('RBAC: local principal is wildcard admin', authorize(localPrincipal(), 'anything', 'admin'));

oidc.close();
dox.close();
rmSync(dbPath, { force: true });
rmSync(dbPath + '-wal', { force: true });
rmSync(dbPath + '-shm', { force: true });

console.log(`\n${PASS.filter(Boolean).length}/${PASS.length} checks passed`);
process.exit(process.exitCode ?? 0);
