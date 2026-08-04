import { AgentDox } from '@agentdox/core';
import { mkdirSync } from 'node:fs';

mkdirSync('data', { recursive: true });
const dox = new AgentDox('data/test.db');

// memory
dox.memory.create({ content: 'Drew works on Ashlands, a 2D Unity RPG with pixel art.', category: 'user', target: 'drew', importance: 0.9, tags: ['project', 'unity'] });
dox.memory.create({ content: 'Pixel art style: hard-edged shading, no outlines, magenta #FF00FF bg, 3/4 top-down.', category: 'user', target: 'drew', importance: 0.85, tags: ['art'] });
dox.memory.create({ content: 'Retro Diffusion pays per use; prefer existing credits before new spend.', category: 'tooling', importance: 0.7, tags: ['budget'] });

// docs
dox.docs.create({ slug: 'guides/pixel-pipeline', title: 'Pixel Art Pipeline', scope: 'ashlands', content: '# Pipeline\n1. Nano Banana 2 for bases.\n2. Retro Diffusion 16-frame rotation.\n3. Unity picker.\n', tags: ['pipeline'] });

// session
const s = dox.sessions.create({ scope: 'ashlands', title: 'Setup' });
dox.sessions.append(s.id, { role: 'user', content: 'What is the pixel art pipeline for Ashlands?' });
dox.sessions.append(s.id, { role: 'assistant', content: 'You use Nano Banana 2 bases then Retro Diffusion rotations.' });

// context assembly
const ctx = dox.context.assemble({ scope: 'ashlands', query: 'pixel art pipeline', memoryLimit: 5, docsLimit: 2, sessionLimit: 10 });

console.log('MEMORY COUNT:', dox.memory.count());
console.log('MEMORY HITS:', ctx.memory.length, 'DOCS:', ctx.docs.length, 'MSGS:', ctx.sessionMessages.length);
console.log('=== PROMPT ===');
console.log(ctx.prompt);
dox.close();
