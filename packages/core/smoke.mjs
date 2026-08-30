import { AgentDox } from '@agentdox/core';
import { mkdirSync } from 'node:fs';

mkdirSync('data', { recursive: true });
const dox = new AgentDox('data/test.db');

// memory
dox.memory.create({ content: 'Alice works on Acme, a TypeScript web app.', category: 'user', target: 'alice', importance: 0.9, tags: ['project', 'web'] });
dox.memory.create({ content: 'Code style: no default exports, explicit return types.', category: 'user', target: 'alice', importance: 0.85, tags: ['style'] });
dox.memory.create({ content: 'CI runs on every PR; prefer fixing flaky tests over retrying.', category: 'tooling', importance: 0.7, tags: ['ci'] });

// docs
dox.docs.create({ slug: 'guides/build-pipeline', title: 'Build Pipeline', scope: 'acme', content: '# Pipeline\n1. Typecheck.\n2. Bundle.\n3. Deploy.\n', tags: ['pipeline'] });

// session
const s = dox.sessions.create({ scope: 'acme', title: 'Setup' });
dox.sessions.append(s.id, { role: 'user', content: 'What is the build pipeline for Acme?' });
dox.sessions.append(s.id, { role: 'assistant', content: 'Typecheck, then bundle, then deploy.' });

// context assembly
const ctx = dox.context.assemble({ scope: 'acme', query: 'build pipeline', memoryLimit: 5, docsLimit: 2, sessionLimit: 10 });

console.log('MEMORY COUNT:', dox.memory.count());
console.log('MEMORY HITS:', ctx.memory.length, 'DOCS:', ctx.docs.length, 'MSGS:', ctx.sessionMessages.length);
console.log('=== PROMPT ===');
console.log(ctx.prompt);
dox.close();
