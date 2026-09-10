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

// ---------- layered assembly (project memory, phase one) ----------
// Three scopes stand in for what the team names: a group ("true across every project"), a
// project everyone shares, and one member's personal thread in it. The assertions pin the
// section order, the per-user recent tail, the handoff leading the personal section, the
// `layers` accounting, and — the one that matters most — that a request carrying only `scope`
// still renders the pre-0.3 block byte for byte.
{
  const GROUP = 'fixture-group';
  const PROJECT = 'fixture-project';
  const PERSONAL = `${PROJECT}.u.alice`;

  await dox.context.saveBrief(GROUP, { overview: 'The platform group owns the deploy pipeline and the shared libraries.', gotchas: 'Never deploy on a Friday.' });
  await dox.context.addDecision(GROUP, { title: 'Sign images', decision: 'cosign on every build', rationale: 'supply chain' });
  for (let i = 0; i < 6; i++) {
    await dox.memory.create({ content: `Group fact ${i}: shared library ${i} is owned by platform.`, category: GROUP, importance: 0.5 + i * 0.05, tags: [] });
  }

  await dox.memory.create({ content: 'The project builds with make and ships as one container.', category: PROJECT, importance: 0.9, tags: [] });
  await dox.memory.create({ content: 'Integration tests need the fake upstream on port 9.', category: PROJECT, importance: 0.8, tags: [] });
  const session = await dox.sessions.create({ scope: PROJECT, title: 'shared' });
  await dox.sessions.append(session.id, { role: 'user', content: 'alice: where does the build config live?', refs: ['user:alice'] });
  await dox.sessions.append(session.id, { role: 'assistant', content: 'alice-answer: in the Makefile at the repo root.', refs: ['user:alice'] });
  await dox.sessions.append(session.id, { role: 'user', content: 'bob: how do I run the integration tests?', refs: ['user:bob'] });
  await dox.sessions.append(session.id, { role: 'assistant', content: 'bob-answer: start the fake upstream first.', refs: ['user:bob'] });
  await dox.sessions.append(session.id, { role: 'user', content: 'untagged: a message recorded by an old router.' });

  const handoff = await dox.memory.create({
    content: 'Done: wired the build. Open: the integration test port clashes. Next: move the fake upstream to port 19.',
    category: PERSONAL, importance: 0.3, tags: ['handoff'],
  });
  await dox.memory.create({ content: 'Alice prefers the Makefile over the wrapper script.', category: PERSONAL, importance: 0.9, tags: [] });
  await dox.memory.create({ content: 'Alice is mid-way through the port change.', category: PERSONAL, importance: 0.7, tags: [] });
  await dox.memory.create({ content: 'A stale handoff from last week.', category: PERSONAL, importance: 0.95, tags: ['handoff'] });
  // The real handoff is the newest one, whatever its importance (a beat later, so the clock moves).
  await new Promise((r) => setTimeout(r, 5));
  await dox.memory.update(handoff.id, { importance: 0.31 });

  // The pre-0.3 block for the project, rendered to the letter: single scope, no query, no brief.
  const plain = await dox.context.assemble({ scope: PROJECT, sessionLimit: 3 });
  const expectedPlain = [
    `# Context: ${PROJECT}`,
    '',
    '## Memory',
    `- (0.90) [${PROJECT}] The project builds with make and ships as one container.`,
    `- (0.80) [${PROJECT}] Integration tests need the fake upstream on port 9.`,
    '',
    '## Docs',
    '(no docs in this scope)',
    '## Recent conversation',
    'user:: bob: how do I run the integration tests?',
    'assistant:: bob-answer: start the fake upstream first.',
    'user:: untagged: a message recorded by an old router.',
  ].join('\n');
  check('a single-scope request renders the pre-0.3 block byte for byte', plain.prompt === expectedPlain, `got:\n${plain.prompt}`);
  check('a single-scope slice reports one project layer', plain.layers.group === null && plain.layers.personal === null && plain.layers.project.chars === plain.prompt.length);

  const layered = await dox.context.assemble({ scope: PROJECT, sessionLimit: 3, group: GROUP, personal: PERSONAL, user: 'alice', groupMemoryLimit: 2, personalLimit: 1 });
  const at = (needle) => layered.prompt.indexOf(needle);
  const groupAt = at(`# Group context: ${GROUP}`);
  const projectAt = at(`# Context: ${PROJECT}`);
  const personalAt = at(`# Your thread in ${PERSONAL}`);
  check('sections render group, then project, then personal', groupAt === 0 && groupAt < projectAt && projectAt < personalAt, `${groupAt} ${projectAt} ${personalAt}`);

  const groupSection = layered.prompt.slice(groupAt, projectAt).trimEnd();
  check('the group section carries the brief and its decision', /Never deploy on a Friday/.test(groupSection) && /Sign images: cosign/.test(groupSection));
  check('the group section carries its top memory, by importance, within the limit',
    /Group fact 5/.test(groupSection) && /Group fact 4/.test(groupSection) && !/Group fact 3/.test(groupSection));

  const projectSection = layered.prompt.slice(projectAt, personalAt).trimEnd();
  check('the recent tail is filtered to the user', /alice-answer/.test(projectSection) && !/bob/.test(projectSection) && !/untagged/.test(projectSection),
    projectSection.split('## Recent conversation')[1]);
  check('the project layer is otherwise the same block', projectSection.startsWith(`# Context: ${PROJECT}\n\n## Memory\n- (0.90)`) && layered.sessionMessages.every((m) => m.refs.includes('user:alice')));

  const personalSection = layered.prompt.slice(personalAt);
  const handoffAt = personalSection.indexOf('## Handoff');
  const notesAt = personalSection.indexOf('## Notes');
  check('the handoff leads the personal section, rendered whole', handoffAt > 0 && handoffAt < notesAt && personalSection.includes('Next: move the fake upstream to port 19.'));
  check('the newest handoff wins over a more important stale one', !/stale handoff/.test(personalSection));
  check('the rest of the personal thread follows by importance, within the limit', /Makefile over the wrapper/.test(personalSection) && !/mid-way/.test(personalSection));

  check('layers account for every section',
    layered.layers.group?.scope === GROUP && layered.layers.group.chars === groupSection.length &&
    layered.layers.project.chars === projectSection.length &&
    layered.layers.personal?.scope === PERSONAL && layered.layers.personal.chars === personalSection.length && layered.layers.personal.handoff === true,
    JSON.stringify(layered.layers));
  check('the whole prompt is the three sections joined by blank lines', layered.prompt === [groupSection, projectSection, personalSection].join('\n\n') && layered.chars === layered.prompt.length);

  // The same request without `user` keeps the untouched project block in the middle.
  const everyone = await dox.context.assemble({ scope: PROJECT, sessionLimit: 3, group: GROUP, personal: PERSONAL });
  check('without `user` the project layer equals the single-scope prompt exactly',
    everyone.prompt.includes(`\n\n${plain.prompt}\n\n`) && everyone.layers.project.chars === plain.prompt.length);

  // Budget: the group section is capped by groupChars, and the memory lines survive the cap.
  const tight = await dox.context.assemble({ scope: PROJECT, group: GROUP, groupChars: 160, groupMemoryLimit: 1 });
  check('groupChars caps the group section and keeps the memory lines', tight.layers.group.chars <= 160 && /Group fact 5/.test(tight.prompt), `${tight.layers.group.chars}\n${tight.prompt.slice(0, 200)}`);

  // Empty layers still name themselves, so the reader sees the shape.
  const empty = await dox.context.assemble({ scope: PROJECT, group: 'nobody', personal: 'nobody.u.x' });
  check('empty layers render a placeholder', /# Group context: nobody\n\(nothing recorded/.test(empty.prompt) && /# Your thread in nobody\.u\.x\n\(no personal thread/.test(empty.prompt) && empty.layers.personal.handoff === false);

  // Author: written when given, absent otherwise, and round-trips through update.
  const authored = await dox.memory.create({ content: 'Authored fact.', category: PROJECT, importance: 0.5, tags: [], author: 'alice' });
  check('memory carries its author', (await dox.memory.get(authored.id))?.author === 'alice');
  check('memory without an author has none', (await dox.memory.get(handoff.id))?.author === undefined);
  check('an update keeps the author', (await dox.memory.update(authored.id, { content: 'Authored fact, edited.' }))?.author === 'alice');

  // recentMessages with a user goes through the dialect's JSON-array fragment; both engines must agree.
  const tail = await dox.sessions.recentMessages(PROJECT, 10, 'bob');
  check('recentMessages filters by user ref', tail.length === 2 && tail.every((m) => /bob/.test(m.content)));

  await dox.sessions.remove(session.id);
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
