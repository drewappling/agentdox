import { AgentDox } from '@agentdox/core';
import { mkdirSync } from 'node:fs';

mkdirSync('data', { recursive: true });
const dox = await AgentDox.open(process.env.AGENTDOX_DATABASE_URL || 'data/test.db');

// memory
await dox.memory.create({ content: 'Alice works on Acme, a TypeScript web app.', category: 'user', target: 'alice', importance: 0.9, tags: ['project', 'web'] });
await dox.memory.create({ content: 'Code style: no default exports, explicit return types.', category: 'user', target: 'alice', importance: 0.85, tags: ['style'] });
await dox.memory.create({ content: 'CI runs on every PR; prefer fixing flaky tests over retrying.', category: 'tooling', importance: 0.7, tags: ['ci'] });

// docs
await dox.docs.create({ slug: 'guides/build-pipeline', title: 'Build Pipeline', scope: 'acme', content: '# Pipeline\n1. Typecheck.\n2. Bundle.\n3. Deploy.\n', tags: ['pipeline'] });

// session
const s = await dox.sessions.create({ scope: 'acme', title: 'Setup' });
await dox.sessions.append(s.id, { role: 'user', content: 'What is the build pipeline for Acme?' });
await dox.sessions.append(s.id, { role: 'assistant', content: 'Typecheck, then bundle, then deploy.' });

// context assembly
const ctx = await dox.context.assemble({ scope: 'acme', query: 'build pipeline', memoryLimit: 5, docsLimit: 2, sessionLimit: 10 });

console.log('MEMORY COUNT:', await dox.memory.count());
console.log('MEMORY HITS:', ctx.memory.length, 'DOCS:', ctx.docs.length, 'MSGS:', ctx.sessionMessages.length);
console.log('=== PROMPT ===');
console.log(ctx.prompt);
await dox.close();
