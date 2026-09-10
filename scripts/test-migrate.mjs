// Store copy round trip: SQLite → Postgres → SQLite, ids and index rows preserved.
// Needs AGENTDOX_TEST_DATABASE_URL (a Postgres the test may create a throwaway schema in).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentDox, copyStore, openStore, storeRowCount } from '@agentdox/core';

const pgUrl = process.env.AGENTDOX_TEST_DATABASE_URL;
if (!pgUrl) {
  console.log('SKIP  store copy round trip — set AGENTDOX_TEST_DATABASE_URL=postgres://… to run it');
  process.exit(0);
}

const results = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n       ${detail}`}`);
  if (!cond) process.exitCode = 1;
  results.push(cond);
};

const dir = mkdtempSync(join(tmpdir(), 'agentdox-migrate-'));
const schema = `agentdox_mig_${Date.now().toString(36)}`;

// 1. A SQLite store with a little of everything.
const a = await AgentDox.open(join(dir, 'a.db'));
await a.projects.ensure({ slug: 'acme', name: 'Acme' });
const m = await a.memory.create({ content: 'The deploy pipeline signs images with cosign.', category: 'acme', importance: 0.9, tags: ['ci'], author: 'alice' });
const anon = await a.memory.create({ content: 'Nobody signed this one.', category: 'acme', importance: 0.4, tags: [] });
const d = await a.docs.create({ slug: 'runbook', title: 'Runbook', scope: 'acme', content: '# Runbook\n\n## Rollback\nRun the rollback job.\n' });
await a.docs.update(d.id, { content: '# Runbook\n\n## Rollback\nRun the rollback job, then page the on-call.\n' });
const s = await a.sessions.create({ scope: 'acme', title: 'kickoff' });
const msg1 = await a.sessions.append(s.id, { role: 'user', content: 'How do we roll back?' });
await a.sessions.append(s.id, { role: 'assistant', content: 'Run the rollback job.' });
await a.context.addDecision('acme', { title: 'Sign images', decision: 'cosign on every build', rationale: 'supply chain' });
await a.context.saveSnapshot('acme');
await a.context.assemble({ scope: 'acme', memoryLimit: 1 }); // one retrieval hit on the top entry
const pat = await a.pat.issue({ name: 'ci', grants: { acme: 'write' } });
// A fake vector, so the embeddings table (BLOB → BYTEA → BLOB) is exercised without a provider.
const vec = new Float32Array([0.25, -0.5, 1]);
await a.store.run('INSERT INTO embeddings (owner_kind, owner_id, scope, model, dims, content_hash, vec, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
  'memory', m.id, 'acme', 'fake', 3, 'h', new Uint8Array(vec.buffer), new Date().toISOString(),
]);
const sourceRows = await storeRowCount(a.store);

// 2. Copy to Postgres, in a throwaway schema.
const pg = await openStore(pgUrl, { schema });
const r1 = await copyStore(a.store, pg);
check('every row reaches Postgres', r1.total === sourceRows, `${r1.total} vs ${sourceRows}`);
let refused = false;
try { await copyStore(a.store, pg); } catch { refused = true; }
check('a second copy onto a non-empty target is refused without replace', refused);
const r2 = await copyStore(a.store, pg, { replace: true });
check('replace empties and recopies', r2.total === sourceRows);

// 3. The Postgres copy serves the same data through the services.
const b = await AgentDox.open(pgUrl, { ...process.env, AGENTDOX_PG_SCHEMA: schema });
check('memory search works on the copy without a rebuild', (await b.memory.search('cosign images', { category: 'acme' }))[0]?.entry.id === m.id);
check('the author column came along', (await b.memory.get(m.id))?.author === 'alice' && (await b.memory.get(anon.id))?.author === undefined);
check('the hit counter came along', (await b.memory.get(m.id))?.hits === 1 && typeof (await b.memory.get(m.id))?.lastHitAt === 'string' && (await b.memory.get(anon.id))?.hits === 0);
check('doc history came along', (await b.docs.history(d.id)).length === 2);
check('message ids are preserved', (await b.sessions.get(s.id))?.messages[0]?.id === msg1.id);
check('an appended message gets an id past the copied ones', ((await b.sessions.append(s.id, { role: 'user', content: 'next' }))?.id ?? 0) > (msg1.id ?? 0) + 1);
check('the brief and its decision survived', (await b.context.getBrief('acme'))?.decisionLog.length === 1);
check('the PAT still authenticates', (await b.pat.findRaw(pat.token))?.grants.acme === 'write');
const emb = await b.store.get('SELECT vec, dims FROM embeddings WHERE owner_id = ?', [m.id]);
const bytes = emb?.vec;
check('the vector round-tripped byte for byte', !!bytes && new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))[2] === 1, `dims=${emb?.dims} bytes=${bytes?.byteLength}`);
await b.close();

// 4. And back to a fresh SQLite file.
const c = await openStore(join(dir, 'c.db'));
const r3 = await copyStore(pg, c);
check('Postgres → SQLite copies every row (plus the appended message)', r3.total === sourceRows + 2, `${r3.total} vs ${sourceRows + 2}`);
await c.close();
const cDox = await AgentDox.open(join(dir, 'c.db'));
check('the SQLite copy searches', (await cDox.memory.search('cosign images', { category: 'acme' }))[0]?.entry.id === m.id);
check('the author survives the round trip', (await cDox.memory.get(m.id))?.author === 'alice');
check('the hits survive the round trip', (await cDox.memory.get(m.id))?.hits === 1);
await cDox.close();

// 5. A store that predates the column gets it on open, on both engines.
{
  const { DatabaseSync } = await import('node:sqlite');
  const oldPath = join(dir, 'old.db');
  const raw = new DatabaseSync(oldPath);
  raw.exec(`CREATE TABLE memory (id TEXT PRIMARY KEY, content TEXT NOT NULL, category TEXT, target TEXT, importance REAL NOT NULL DEFAULT 0.5,
    tags_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, source TEXT)`);
  raw.exec(`INSERT INTO memory (id, content, category, importance, created_at, updated_at) VALUES ('mem_old', 'from before', 'acme', 0.5, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
  raw.close();
  const upgraded = await AgentDox.open(oldPath);
  check('SQLite: a pre-0.3 store gains the author column on open', (await upgraded.memory.get('mem_old'))?.content === 'from before' && (await upgraded.memory.get('mem_old'))?.author === undefined);
  check('SQLite: and the hit columns, at zero', (await upgraded.memory.get('mem_old'))?.hits === 0 && (await upgraded.memory.get('mem_old'))?.lastHitAt === undefined);
  const w = await upgraded.memory.create({ content: 'written after the upgrade', category: 'acme', importance: 0.5, tags: [], author: 'bob' });
  check('SQLite: and the column is writable', (await upgraded.memory.get(w.id))?.author === 'bob');
  await upgraded.context.assemble({ scope: 'acme' });
  check('SQLite: an old row takes hits after the upgrade', (await upgraded.memory.get('mem_old'))?.hits === 1);
  await upgraded.close();

  const oldSchema = `${schema}_old`;
  await pg.exec(`CREATE SCHEMA "${oldSchema}"`);
  await pg.exec(`CREATE TABLE "${oldSchema}".memory (id TEXT PRIMARY KEY, content TEXT NOT NULL, category TEXT, target TEXT, importance DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    tags_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, source TEXT)`);
  await pg.exec(`INSERT INTO "${oldSchema}".memory (id, content, category, importance, created_at, updated_at) VALUES ('mem_old', 'from before', 'acme', 0.5, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
  const upgradedPg = await AgentDox.open(pgUrl, { ...process.env, AGENTDOX_PG_SCHEMA: oldSchema });
  check('Postgres: a pre-0.3 store gains the author column on open', (await upgradedPg.memory.get('mem_old'))?.content === 'from before');
  check('Postgres: and the hit columns, at zero', (await upgradedPg.memory.get('mem_old'))?.hits === 0 && (await upgradedPg.memory.get('mem_old'))?.lastHitAt === undefined);
  const w2 = await upgradedPg.memory.create({ content: 'written after the upgrade', category: 'acme', importance: 0.5, tags: [], author: 'bob' });
  check('Postgres: and the column is writable', (await upgradedPg.memory.get(w2.id))?.author === 'bob');
  await upgradedPg.context.assemble({ scope: 'acme' });
  check('Postgres: an old row takes hits after the upgrade', (await upgradedPg.memory.get('mem_old'))?.hits === 1);
  // Reopening must be a no-op, not a failed ALTER.
  const again = await AgentDox.open(pgUrl, { ...process.env, AGENTDOX_PG_SCHEMA: oldSchema });
  check('Postgres: reopening an upgraded store is idempotent', (await again.memory.get(w2.id))?.author === 'bob');
  await again.close();
  await upgradedPg.close();
  await pg.exec(`DROP SCHEMA "${oldSchema}" CASCADE`);
}

console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
await pg.exec(`DROP SCHEMA "${schema}" CASCADE`);
await pg.close();
await a.close();
rmSync(dir, { recursive: true, force: true });
