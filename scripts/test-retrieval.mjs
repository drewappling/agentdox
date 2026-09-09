// Regression fixture for retrieval ranking.
//
// This exists because the ranking bugs it guards against were invisible without measurement:
// the original scorer confidently returned the three longest entries in a scope, and a later
// AND-biased query builder confidently returned one wrong entry. Both looked like working
// search. A ranking change that regresses this file should fail here, not six weeks later in
// somebody's session.
//
// The corpus is synthetic and self-contained so the test is deterministic and portable — it
// must not depend on whatever happens to be in the developer's live store.
//
// Runs on SQLite by default. AGENTDOX_TEST_DATABASE_URL=postgres://… runs the same fixture on
// Postgres, in a throwaway schema that is dropped at the end, so both engines are held to the
// same ranking bar.
//
// Embeddings are optional. Lexical assertions always run; the vector-dependent ones are
// skipped (loudly) when no provider is reachable, because CI usually has no model server.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentDox } from '@agentdox/core';

const results = [];
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n       ${detail}`}`);
  if (!cond) process.exitCode = 1;
  results.push(cond);
};

const dir = mkdtempSync(join(tmpdir(), 'agentdox-retrieval-'));
const pgUrl = process.env.AGENTDOX_TEST_DATABASE_URL;
const schema = `agentdox_test_${Date.now().toString(36)}`;
const dox = await AgentDox.open(pgUrl || join(dir, 'test.db'), { ...process.env, ...(pgUrl ? { AGENTDOX_PG_SCHEMA: schema } : {}) });
console.log(`storage: ${dox.storage}`);
const SCOPE = 'fixture';

// ---------- corpus ----------
// Deliberately mixed lengths: the decoys are long and repeat common words, which is exactly
// what defeated the term-frequency scorer.
const LONG_DECOY = `
Quarterly logistics review covering the northern depot and the southern depot. The depot
inventory is reconciled every week and the reconciliation is signed off by the duty officer.
Depot staffing is reviewed in the same meeting, and the meeting notes are filed with the
operations record. `.repeat(6);

const MEMORY = [
  ['The scheduler uses a fixed base interval, not exponential backoff, because retries must stay evenly spaced.', 0.8],
  ['CarriageBuilder.Assemble is the only runtime caller of WheelLayout.Solve; everything else goes through the editor probe.', 0.9],
  ['Nightly export batches run headless via the batch runner; editing files under the asset root mid-run triggers a reload that wipes the job queue.', 0.7],
  ['Never ask the operator to re-confirm a decision that is already written down — read the decision log first.', 0.9],
  [`Depot logistics notes. ${LONG_DECOY}`, 0.5],
  [`Meeting minutes archive. ${LONG_DECOY}`, 0.5],
  ['Colour grading was moved from the capture stage to the compositor in the 4.2 release.', 0.6],
];
for (const [content, importance] of MEMORY) {
  await dox.memory.create({ content, category: SCOPE, importance, tags: [] });
}

await dox.docs.create({
  slug: 'fixture/handbook',
  title: 'Field handbook',
  scope: SCOPE,
  content: `# Field handbook

## Introduction
This handbook collects operating procedure. It is long, and its opening section says nothing
useful about any specific system, which is the point: whole-document retrieval would return
this preamble and truncate away everything below.
${LONG_DECOY}

## Wheel alignment
Wheel alignment is checked against the reference jig before every run. WheelLayout.Solve
returns the alignment plan and CarriageBuilder.Assemble consumes it. A misaligned wheel shows
up as uneven tyre wear within two runs.

## Cold weather starting
Below freezing, prime the pump twice and wait thirty seconds between attempts. The starter
draws heavily and a marginal battery will read fine at rest and still fail under load.
`,
});
await dox.docs.create({
  slug: 'fixture/appendix',
  title: 'Appendix',
  scope: SCOPE,
  content: `# Appendix\n\n## Glossary\n${LONG_DECOY}\n\n## Revision history\nRevised quarterly.\n`,
});

// ---------- lexical assertions (always run) ----------
const topMemory = async (q) => (await dox.memory.search(q, { category: SCOPE, limit: 3 })).map((h) => h.entry.content);
const topPassages = async (q) => (await dox.docs.searchChunks(q, { scope: SCOPE, limit: 3 }));
const findMemory = async (prefix) => (await dox.memory.list({ category: SCOPE, limit: 200 })).find((e) => e.content.startsWith(prefix));

const stats = await dox.index.stats(SCOPE);
check('index builds on write', stats.memory.total === MEMORY.length && stats.chunks.total > 0,
  `memory=${stats.memory.total} chunks=${stats.chunks.total}`);

{
  const hits = await topMemory('which class calls WheelLayout.Solve at runtime');
  check('identifier lookup returns the identifier entry', /CarriageBuilder\.Assemble/.test(hits[0] ?? ''), `got: ${(hits[0] ?? '').slice(0, 90)}`);
}
{
  const hits = await topMemory('how do nightly export batches run');
  check('phrase lookup beats the long decoys', /Nightly export batches/.test(hits[0] ?? ''), `got: ${(hits[0] ?? '').slice(0, 90)}`);
}
{
  // The regression that motivated the fixture: every result here used to be a long decoy.
  const hits = await topMemory('what interval does the scheduler use');
  check('no length bias: short exact answer outranks long decoys', /fixed base interval/.test(hits[0] ?? ''), `got: ${(hits[0] ?? '').slice(0, 90)}`);
}
{
  const hits = await topMemory('colour grading stage');
  check('stemming matches grading/graded', /Colour grading/.test(hits[0] ?? ''), `got: ${(hits[0] ?? '').slice(0, 90)}`);
}
{
  const ps = await topPassages('wheel alignment reference jig');
  check('passage retrieval targets the right section, not the preamble',
    /Wheel alignment/.test(ps[0]?.heading ?? ''), `got heading: ${ps[0]?.heading ?? '(none)'}`);
  check('passage is a passage, not a whole document', (ps[0]?.content.length ?? 1e9) < 2000,
    `passage length ${ps[0]?.content.length}`);
}
{
  const ps = await topPassages('starting the engine in freezing weather');
  check('passage retrieval finds a section by topic',
    /Cold weather/.test(ps[0]?.heading ?? ''), `got heading: ${ps[0]?.heading ?? '(none)'}`);
}
{
  const before = await topMemory('colour grading stage');
  const entry = await findMemory('Colour grading');
  await dox.memory.update(entry.id, { content: 'Tone mapping moved from the capture stage to the compositor in the 4.2 release.' });
  const after = await topMemory('tone mapping compositor');
  check('an edited entry is searchable by its new text', /Tone mapping/.test(after[0] ?? ''), `got: ${(after[0] ?? '').slice(0, 90)}`);
  check('and no longer by the old text', !/Colour grading/.test((await topMemory('colour grading stage'))[0] ?? ''),
    `before: ${(before[0] ?? '').slice(0, 40)}`);
  await dox.memory.update(entry.id, { content: MEMORY[6][0] });
}
{
  const removed = await findMemory('Depot logistics');
  await dox.memory.remove(removed.id);
  const hits = await topMemory('depot logistics reconciliation');
  check('a deleted entry leaves the index', !hits.some((h) => h.startsWith('Depot logistics')));
  await dox.memory.create({ content: MEMORY[4][0], category: SCOPE, importance: 0.5, tags: [] });
}
{
  // Tag filters and null-safe slug lookups go through the dialect fragments; both engines must agree.
  const tagged = await dox.memory.create({ content: 'A tagged fact for the filter test.', category: SCOPE, importance: 0.4, tags: ['alpha', 'beta'] });
  const byTag = await dox.memory.list({ category: SCOPE, tag: 'beta' });
  check('tag filter finds the tagged entry only', byTag.length === 1 && byTag[0].id === tagged.id, `got ${byTag.length}`);
  await dox.memory.remove(tagged.id);
  const bySlug = await dox.docs.getBySlug('fixture/appendix', SCOPE);
  check('slug lookup within a scope', bySlug?.title === 'Appendix');
  check('slug lookup in another scope finds nothing', (await dox.docs.getBySlug('fixture/appendix', 'elsewhere')) === null);
}
{
  // Sessions: messages get ids from the engine, and relevance reaches past the recent tail.
  const s = await dox.sessions.create({ scope: SCOPE, title: 'fixture' });
  const first = await dox.sessions.append(s.id, { role: 'user', content: 'The pump primer valve sticks in cold weather, remember that.' });
  for (let i = 0; i < 6; i++) await dox.sessions.append(s.id, { role: 'assistant', content: `filler turn ${i}` });
  check('appended messages carry numeric ids', Number.isInteger(first.id));
  const older = await dox.sessions.relevantMessages(SCOPE, 'primer valve sticking', { limit: 2 });
  check('an older relevant message is found by search', older.some((m) => /primer valve/.test(m.content)));
  const ctx = await dox.context.assemble({ scope: SCOPE, query: 'primer valve', sessionLimit: 3 });
  check('context assembly renders memory, passages and conversation', /## Memory/.test(ctx.prompt) && ctx.sessionMessages.length > 0);
  check('snapshot round-trips', (await dox.context.saveSnapshot(SCOPE)).chars > 0 && (await dox.context.getSnapshot(SCOPE))?.scope === SCOPE);
  check('scheduler targets include the fixture scope', (await dox.context.targetScopes()).includes(SCOPE));
}
{
  const rebuilt = await dox.index.rebuildLexical();
  check('a rebuild re-indexes everything', rebuilt.memory === MEMORY.length && rebuilt.chunks > 0 && rebuilt.messages === 7, JSON.stringify(rebuilt));
  const hits = await topMemory('which class calls WheelLayout.Solve at runtime');
  check('search still works after the rebuild', /CarriageBuilder\.Assemble/.test(hits[0] ?? ''));
}

// ---------- vector assertions (only when a provider answers) ----------
const provider = dox.index.embeddingProvider;
let reachable = false;
if (provider) {
  try {
    await provider.embed(['probe'], 'query');
    reachable = true;
  } catch {
    reachable = false;
  }
}

if (!reachable) {
  console.log(
    `SKIP  vector assertions — ${provider ? `provider '${provider.id}' unreachable` : 'no embedding provider configured'}` +
      '\n       (set AGENTDOX_EMBED_PROVIDER=ollama with a model server running to exercise them)',
  );
} else {
  const r = await dox.index.backfillEmbeddings({ scope: SCOPE });
  check('backfill embeds the corpus', r.embedded > 0 && !r.error, JSON.stringify(r));
  check('backfill is idempotent', (await dox.index.backfillEmbeddings({ scope: SCOPE })).embedded === 0);

  {
    // Vocabulary mismatch: shares no content word with the stored entry. This is the class
    // BM25 cannot reach, and the whole reason the vector arm exists.
    const hits = await topMemory('avoid pestering the user with things they already told us');
    check('semantic match with no shared vocabulary', /re-confirm a decision/.test(hits.join(' ')),
      `got: ${(hits[0] ?? '').slice(0, 90)}`);
  }
  {
    // Hybrid must not lose what lexical was good at once vectors join the fusion.
    const hits = await topMemory('which class calls WheelLayout.Solve at runtime');
    check('identifier lookup survives fusion with vectors', /CarriageBuilder\.Assemble/.test(hits[0] ?? ''),
      `got: ${(hits[0] ?? '').slice(0, 90)}`);
  }
  {
    const entry = await findMemory('Nightly export');
    const hashOf = async () =>
      (await dox.store.get('SELECT content_hash FROM embeddings WHERE owner_id = ?', [entry.id]))?.content_hash;
    const before = await hashOf();
    await dox.memory.update(entry.id, { content: 'Nightly export batches were replaced by an on-demand queue in release 5.0.' });
    await dox.index.backfillEmbeddings({ scope: SCOPE });
    check('an edited entry is re-embedded (content_hash is compared)', before !== (await hashOf()));
  }
}

// ---------- teardown ----------
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
if (pgUrl) await dox.store.exec(`DROP SCHEMA "${schema}" CASCADE`);
await dox.close();
rmSync(dir, { recursive: true, force: true });
