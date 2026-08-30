// Test agentdox end-to-end THROUGH its own SDK, against the live stack, with a real
// Keycloak user token (RBAC enforced). Run inside the agentdox-server container.
import { AgentDoxClient } from '@agentdox/sdk';

const KC = 'http://keycloak:8080/realms/agentdox';
const DOX = 'http://127.0.0.1:3003';

const pass = (n, ok) => console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`);

// 1) Get a real user OIDC token (alice: demo=write, acme=read)
const tr = await fetch(`${KC}/protocol/openid-connect/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: 'grant_type=password&client_id=agentdox-server&client_secret=agentdox-server-dev-secret&username=alice&password=demo123',
});
const tj = await tr.json();
pass('got OIDC token', !!tj.access_token);
const at = tj.access_token;

const client = new AgentDoxClient(DOX, fetch, at);
const publicClient = new AgentDoxClient(DOX);

// 2) Write into demo scope (alice has write) — via SDK
try {
  const m = await client.memory.create({ content: 'created via @agentdox/sdk', category: 'demo', importance: 0.9 });
  pass('SDK create memory in demo (write)', !!m.id);
  console.log(`      -> id ${m.id}`);

  const got = await client.memory.get(m.id);
  pass('SDK read back the memory', got.id === m.id && got.content.includes('agentdox/sdk'));
} catch (e) {
  pass('SDK create memory in demo (write)', false);
  console.log('      ', e.message.slice(0, 100));
}

// 3) Assemble context for demo — via SDK
try {
  const ctx = await client.context.assemble({ scope: 'demo', query: 'agentdox', memoryLimit: 15 });
  pass('SDK assemble context (demo)', ctx.chars > 0 && Array.isArray(ctx.memory));
  console.log(`      -> chars=${ctx.chars} memoryHits=${ctx.memory.length}`);
} catch (e) {
  pass('SDK assemble context (demo)', false);
  console.log('      ', e.message.slice(0, 100));
}

// 4) Write into acme scope — alice is READ-only there -> expect 403
try {
  await client.memory.create({ content: 'should fail', category: 'acme' });
  pass('SDK write to acme denied (read-only)', false);
} catch (e) {
  pass(`SDK write to acme denied (read-only)  [${e.message.match(/\d{3}/)?.[0] || 'err'}]`, /403/.test(e.message));
}

// 5) No token -> expect 401
try {
  await publicClient.memory.list();
  pass('no-token access denied', false);
} catch (e) {
  pass(`no-token access denied  [${e.message.match(/\d{3}/)?.[0] || 'err'}]`, /401/.test(e.message));
}
