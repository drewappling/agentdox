// Quick smoke of the projects API via Fastify inject (no listening socket).
import { buildApp } from '@agentdox/server';

const { app, dox } = buildApp({ authEnabled: false, dbPath: ':memory:' });
let pass = 0, fail = 0;
const check = (n, cond) => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${n}`); };

// 1. Provision a new project (auth disabled -> project + null token)
let r = await app.inject({ method: 'POST', url: '/projects', payload: { slug: 'ashlands', name: 'Ashlands' } });
check('create project -> 201/200', r.statusCode === 200 || r.statusCode === 201);
const created = r.json();
check('project slug == ashlands', created.project?.slug === 'ashlands');
check('token is null when auth disabled', created.token === null);

// 2. Ensure is idempotent (no duplicate + still one project)
r = await app.inject({ method: 'POST', url: '/projects', payload: { slug: 'ashlands', name: 'Ashlands 2' } });
check('ensure returns same project (idempotent)', r.json().project?.id === created.project?.id);

// 3. List projects
r = await app.inject({ method: 'GET', url: '/projects' });
const list = r.json();
check('list contains ashlands', Array.isArray(list) && list.some((p) => p.slug === 'ashlands'));

// 4. Get by slug
r = await app.inject({ method: 'GET', url: '/projects/ashlands' });
check('get /projects/ashlands -> 200', r.statusCode === 200 && r.json().name === 'Ashlands');

// 5. The project scope is the category/scope namespace for memory
r = await app.inject({ method: 'POST', url: '/memory', payload: { content: 'project fact', category: 'ashlands' } });
check('write memory into project scope -> 200', r.statusCode === 200);
r = await app.inject({ method: 'POST', url: '/context/assemble', payload: { scope: 'ashlands' } });
const ctx = r.json();
check('assemble context for project scope -> has prompt', r.statusCode === 200 && typeof ctx.prompt === 'string');

// 6. MCP path shares the same DB (direct core access)
const mcpProject = dox.projects.ensure({ slug: 'hermes', name: 'Hermes' });
check('core ProjectService ensure (MCP path) works', mcpProject.slug === 'hermes');
check('core lists both projects', dox.projects.list().length >= 2);

console.log(`\n${pass} passed, ${fail} failed`);
await app.close();
dox.close();
process.exit(fail ? 1 : 0);
