// Export / import round trip (project memory, phase three).
//
// A scope's project row, brief, memory, docs (with their revisions) and sessions (with their
// messages) go out as one JSON document and come back in under any scope name, ids intact, so
// offboarding (a member's thread), migration (a project to another deployment) and a restore
// are all the same file. Two fresh stores stand in for two deployments.
//
// Runs on SQLite by default. AGENTDOX_TEST_DATABASE_URL=postgres://… runs the core round trip
// on Postgres too (two throwaway schemas, dropped at the end). The route grants run against a
// real server with auth on, the way test-server-auth does.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { AgentDox, storeRowCount } from '@agentdox/core';
import { startServer } from '../packages/server/dist/index.js';

const results = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n       ${detail}`}`);
  if (!cond) process.exitCode = 1;
  results.push(cond);
};

const dir = mkdtempSync(join(tmpdir(), 'agentdox-export-'));
const pgUrl = process.env.AGENTDOX_TEST_DATABASE_URL;
const schema = `agentdox_exp_${Date.now().toString(36)}`;
const open = (name) => AgentDox.open(pgUrl || join(dir, `${name}.db`), { ...process.env, ...(pgUrl ? { AGENTDOX_PG_SCHEMA: `${schema}_${name}` } : {}) });

// What an export looks like with the parts that legitimately differ between two stores removed:
// the export clock, and message ids (the engine's, minted afresh on import).
const stable = (ex) =>
  JSON.stringify({
    ...ex,
    exportedAt: undefined,
    project: ex.project && { ...ex.project, id: undefined, createdAt: undefined },
    sessions: ex.sessions.map((s) => ({ ...s, messages: s.messages.map(({ id, ...m }) => m) })),
  });
const ids = (rows) => rows.map((r) => r.id).sort();

// ---------- source store ----------
const a = await open('a');
console.log(`storage: ${a.storage}`);
const SCOPE = 'acme';
await a.projects.ensure({ slug: SCOPE, name: 'Acme', description: 'the source project' });
await a.context.saveBrief(SCOPE, { overview: 'Acme ships a router.', gotchas: 'Never deploy on a Friday.' });
await a.context.addDecision(SCOPE, { title: 'Sign images', decision: 'cosign on every build', rationale: 'supply chain' });
const top = await a.memory.create({ content: 'The deploy pipeline signs images with cosign.', category: SCOPE, target: 'ci', importance: 0.9, tags: ['ci'], source: 'user-stated', author: 'alice' });
await a.memory.create({ content: 'Integration tests need the fake upstream on port 9.', category: SCOPE, importance: 0.7, tags: [] });
await a.memory.create({ content: 'Done: wired the build. Next: move the fake upstream.', category: SCOPE, importance: 0.3, tags: ['handoff'] });
await a.context.assemble({ scope: SCOPE, memoryLimit: 1 }); // a hit on the top entry, so the counter travels
const doc = await a.docs.create({ slug: 'runbook', title: 'Runbook', scope: SCOPE, content: '# Runbook\n\n## Rollback\nRun the rollback job.\n', tags: ['ops'] });
await a.docs.update(doc.id, { content: '# Runbook\n\n## Rollback\nRun the rollback job, then page the on-call.\n' });
const session = await a.sessions.create({ scope: SCOPE, title: 'kickoff' });
await a.sessions.append(session.id, { role: 'user', content: 'alice: how do we roll back?', refs: ['user:alice'] });
await a.sessions.append(session.id, { role: 'assistant', content: 'Run the rollback job, then page the on-call.' });
await a.sessions.end(session.id);
// Another scope, to prove an export takes nothing from it.
await a.memory.create({ content: 'A fact from elsewhere.', category: 'other', importance: 0.9, tags: [] });
await a.docs.create({ slug: 'runbook', title: 'Other runbook', scope: 'other', content: '# Other\n' });
await a.sessions.create({ scope: 'other', title: 'elsewhere' });

// ---------- export ----------
const ex = await a.exportScope(SCOPE);
check('the document names its format, version and scope', ex.format === 'agentdox-export' && ex.version === 1 && ex.scope === SCOPE && typeof ex.exportedAt === 'string');
check('the project row and the brief come along', ex.project?.slug === SCOPE && ex.project.name === 'Acme' && ex.brief?.gotchas === 'Never deploy on a Friday.' && ex.brief.decisionLog.length === 1);
check('memory comes along whole, hits included', ex.memory.length === 3 && ex.memory.find((e) => e.id === top.id)?.hits === 1 && typeof ex.memory.find((e) => e.id === top.id)?.lastHitAt === 'string' && ex.memory.find((e) => e.id === top.id)?.author === 'alice');
check('docs come along with their revisions', ex.docs.length === 1 && ex.docs[0].id === doc.id && ex.docs[0].version === 2 && ex.docs[0].versions?.length === 2);
check('sessions come along with their messages', ex.sessions.length === 1 && ex.sessions[0].id === session.id && ex.sessions[0].messages.length === 2 && ex.sessions[0].messages[0].refs.includes('user:alice') && typeof ex.sessions[0].endedAt === 'string');
check('nothing from another scope', ex.memory.every((e) => e.category === SCOPE) && ex.docs.every((d) => d.scope === SCOPE) && ex.sessions.every((s) => s.scope === SCOPE));
const empty = await a.exportScope('nobody');
check('a scope with nothing exports empty arrays and nulls', empty.scope === 'nobody' && empty.project === null && empty.brief === null && empty.memory.length === 0 && empty.docs.length === 0 && empty.sessions.length === 0);
check('the document survives JSON', stable(JSON.parse(JSON.stringify(ex))) === stable(ex));

// ---------- import into a second store, under another name ----------
const b = await open('b');
const MOVED = 'acme-moved';
const body = { ...JSON.parse(JSON.stringify(ex)), scope: MOVED };
const report = await b.importScope(body);
check('the import reports what it wrote', JSON.stringify(report) === JSON.stringify({ memory: 3, docs: 1, sessions: 1, messages: 2, brief: true }), JSON.stringify(report));
const ex2 = await b.exportScope(MOVED);
check('ids are preserved', JSON.stringify(ids(ex2.memory)) === JSON.stringify(ids(ex.memory)) && JSON.stringify(ids(ex2.docs)) === JSON.stringify(ids(ex.docs)) && JSON.stringify(ids(ex2.sessions)) === JSON.stringify(ids(ex.sessions)));
check('the scope is renamed throughout', ex2.scope === MOVED && ex2.project?.slug === MOVED && ex2.project.name === 'Acme' && ex2.brief?.scope === MOVED && ex2.memory.every((e) => e.category === MOVED) && ex2.docs.every((d) => d.scope === MOVED) && ex2.sessions.every((s) => s.scope === MOVED));
const renamed = (e) => JSON.stringify({ ...e, scope: MOVED, project: e.project && { ...e.project, slug: MOVED }, brief: e.brief && { ...e.brief, scope: MOVED }, memory: e.memory.map((m) => ({ ...m, category: MOVED })), docs: e.docs.map((d) => ({ ...d, scope: MOVED })), sessions: e.sessions.map((s) => ({ ...s, scope: MOVED })) });
check('and everything else is equal: entries, hits, revisions, messages, the brief', stable(JSON.parse(renamed(ex))) === stable(ex2), `\n${stable(JSON.parse(renamed(ex)))}\n${stable(ex2)}`);
check('the copy is searchable without a rebuild',
  (await b.memory.search('cosign images', { category: MOVED }))[0]?.entry.id === top.id &&
    /Rollback/.test((await b.docs.searchChunks('rollback job on-call', { scope: MOVED }))[0]?.heading ?? '') &&
    (await b.sessions.relevantMessages(MOVED, 'roll back', { limit: 1 })).length === 1);
check('the target project row exists once', (await b.projects.list()).filter((p) => p.slug === MOVED).length === 1);

// ---------- idempotence ----------
const rowsBefore = await storeRowCount(b.store);
const again = await b.importScope(body);
check('importing the same file twice changes nothing', (await storeRowCount(b.store)) === rowsBefore && stable(await b.exportScope(MOVED)) === stable(ex2) && JSON.stringify(again) === JSON.stringify(report));

// ---------- an edited file updates in place ----------
const edited = JSON.parse(JSON.stringify(body));
edited.memory.find((e) => e.id === top.id).content = 'The deploy pipeline signs images with cosign (edited).';
edited.brief.gotchas = 'Never deploy on a Friday, or a Monday.';
await b.importScope(edited);
check('an edited entry is updated by id', (await b.memory.get(top.id))?.content.endsWith('(edited).') && (await b.memory.count()) === 3);
check('the brief is replaced whole', (await b.context.getBrief(MOVED))?.gotchas.endsWith('or a Monday.'));
let refused = false;
try { await b.importScope({ scope: MOVED, memory: [] }); } catch { refused = true; }
check('a body that is not an export is refused', refused);

// ---------- routes: the grants, through a real server with auth on ----------
const ADMIN = 'admin-secret-xyz';
const { port, app, dox: served, stopScheduler } = await startServer({
  port: 0,
  host: '127.0.0.1',
  logger: false,
  dbPath: join(dir, 'server.db'),
  authEnabled: true,
  env: { AGENTDOX_AUTH_ENABLED: 'true', AGENTDOX_ADMIN_TOKEN: ADMIN, AGENTDOX_CONTEXT_INTERVAL_SECONDS: '0' },
});
const base = `http://127.0.0.1:${port}`;
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

const reader = (await post('/auth/tokens', ADMIN, { name: 'demo-reader', grants: { demo: 'read' } })).body.token;
const writer = (await post('/auth/tokens', ADMIN, { name: 'demo-writer', grants: { demo: 'write' } })).body.token;
await post('/memory', ADMIN, { content: 'demo fact', category: 'demo', importance: 0.9 });
await post('/docs', ADMIN, { slug: 'demo-doc', title: 'Demo doc', content: '# Demo\n', scope: 'demo' });
await post('/memory', ADMIN, { content: 'acme secret', category: 'acme', importance: 0.9 });

let r = await get('/export');
check('GET /export without a scope -> 400', r.status === 400);
r = await get('/export?scope=demo');
check('GET /export without a token -> 401', r.status === 401);
r = await get('/export?scope=demo', reader);
check('a reader exports its scope -> 200, the document', r.status === 200 && r.body.format === 'agentdox-export' && r.body.memory.length === 1 && r.body.docs.length === 1);
check('listed entries carry hits and lastHitAt', 'hits' in r.body.memory[0] && r.body.memory[0].hits === 0 && !('lastHitAt' in r.body.memory[0]));
const demoExport = r.body;
r = await get('/export?scope=acme', reader);
check('a reader cannot export a scope it lacks -> 403', r.status === 403);
r = await post('/import', reader, { ...demoExport, scope: 'demo' });
check('a reader cannot import -> 403', r.status === 403);
r = await post('/import', writer, { ...demoExport, scope: 'demo' });
check('a writer imports into its scope -> 200, the counts', r.status === 200 && r.body.imported?.memory === 1 && r.body.imported.docs === 1 && r.body.imported.sessions === 0 && r.body.imported.brief === false, JSON.stringify(r.body));
r = await post('/import', writer, { ...demoExport, scope: 'acme' });
check('the scope in the body decides the grant -> 403 elsewhere', r.status === 403);
r = await post('/import', ADMIN, { scope: 'demo' });
check('a body that is not an export -> 400', r.status === 400 && r.body.error === 'invalid_export');
// A turn through the API counts a hit, and the listing shows it.
await post('/context/assemble', writer, { scope: 'demo' });
r = await get('/memory?category=demo', reader);
check('GET /memory reports hits and lastHitAt after an assembly', r.body[0]?.hits === 1 && typeof r.body[0]?.lastHitAt === 'string', JSON.stringify(r));

// Ids are global, so within one store an import under another name is a move, not a copy.
r = await post('/import', ADMIN, { ...demoExport, scope: 'demo-copy' });
check('an admin imports under a new name', r.status === 200 && r.body.imported.memory === 1);
r = await get('/memory?category=demo-copy', ADMIN);
check('the entries list under the new scope with the same ids', r.status === 200 && r.body.length === 1 && r.body[0].id === demoExport.memory[0].id && r.body[0].category === 'demo-copy');
r = await get('/memory?category=demo', ADMIN);
check('and are gone from the old one: same store, same ids, a rename', r.status === 200 && r.body.length === 0);

// ---------- teardown ----------
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
if (pgUrl) {
  await a.store.exec(`DROP SCHEMA "${schema}_a" CASCADE`);
  await b.store.exec(`DROP SCHEMA "${schema}_b" CASCADE`);
}
await a.close();
await b.close();
stopScheduler();
await app.close();
await served.close();
rmSync(dir, { recursive: true, force: true });
process.exit(results.every(Boolean) ? 0 : 1);
