import { AgentDox } from '@agentdox/core';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const dbPath = resolve(root, 'data', 'agentdox.db');
mkdirSync(resolve(root, 'data'), { recursive: true });

const dox = new AgentDox(dbPath);

if (dox.memory.count() > 0 || dox.docs.list({ limit: 1 }).length > 0) {
  console.log('[seed] Database already contains data — skipping (delete data/agentdox.db to reset).');
  dox.close();
  process.exit(0);
}

const scope = 'demo';

// ---- Memory ----
const mem = [
  { content: 'agentdox is a dynamic context, memory, and documentation framework for AI agents.', category: scope, target: 'agentdox', importance: 0.95, tags: ['agentdox', 'concept'] },
  { content: 'Core concepts: Memory (durable facts), Docs (versioned markdown), Context (assembled on demand).', category: scope, target: 'agentdox', importance: 0.9, tags: ['architecture'] },
  { content: 'Everything is exposed via REST, an MCP server, and a web UI.', category: scope, target: 'agentdox', importance: 0.85, tags: ['interfaces'] },
  { content: 'Storage uses SQLite behind an abstraction, so Postgres can be swapped in later.', category: scope, target: 'agentdox', importance: 0.75, tags: ['storage'] },
  { content: 'Context is built at request time — never pre-baked into prompts.', category: scope, target: 'agentdox', importance: 0.8, tags: ['design'] },
];
for (const m of mem) {
  dox.memory.create(m);
  console.log(`[seed] memory: ${m.content.slice(0, 60)}…`);
}

// ---- Docs ----
const docs = [
  {
    slug: 'readme',
    title: 'README',
    scope,
    content: `# agentdox\n\nAn open-source dynamic context, memory, and documentation framework for AI agents.\n\n## Interfaces\n- **REST API** — the spine, for web UI and HTTP clients.\n- **MCP server** — standard model-context-protocol tools for any agent.\n- **Web UI** — browse, edit, and inspect memory, docs, and assembled context.`,
    tags: ['overview'],
  },
  {
    slug: 'guides/context-assembly',
    title: 'How Context Assembly Works',
    scope,
    content: `# Context Assembly\n\nWhen an agent asks for context, agentdox: \n\n1. Searches **memory** in the scope, ranking by relevance + importance.\n2. Pulls **docs** matching the query (or most-recent in scope).\n3. Appends recent **session** messages.\n4. Renders them into a single prompt-ready block.\n\nThe result is computed fresh on every request — nothing is cached or pre-baked.`,
    tags: ['guides'],
  },
];
for (const d of docs) {
  dox.docs.create(d);
  console.log(`[seed] doc: ${d.slug}`);
}

// ---- Session ----
const s = dox.sessions.create({ scope, title: 'Kickoff' });
dox.sessions.append(s.id, { role: 'user', content: 'How does agentdox give an agent context?' });
dox.sessions.append(s.id, { role: 'assistant', content: 'You assemble it on demand: memory + docs + recent conversation, scoped to the agent.' });
console.log(`[seed] session: ${s.id}`);

// ---- Demonstrate context ----
const ctx = dox.context.assemble({ scope, query: 'how is context assembled', memoryLimit: 6, docsLimit: 2, sessionLimit: 10 });
console.log('\n[seed] === Assembled context (prompt block) ===\n');
console.log(ctx.prompt);
console.log(`\n[seed] done. Total memory: ${dox.memory.count()}, docs: ${dox.docs.list({ limit: 50 }).length}, sessions: ${dox.sessions.list().length}`);
dox.close();
