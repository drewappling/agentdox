// Quick smoke of the projects API via Fastify inject (no listening socket).
import { buildApp } from '@agentdox/server';

const { app, dox } = buildApp({ authEnabled: false, dbPath: ':memory:' });
let pass = 0, fail = 0;
const check = (n, cond) => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${n}`); };

// 1. Provision a new project (auth disabled -> project + null token)
let r = await app.inject({ method: 'POST', url: '/projects', payload: { slug: 'acme', name: 'Acme' } });
check('create project -> 201/200', r.statusCode === 200 || r.statusCode === 201);
const created = r.json();
check('project slug == acme', created.project?.slug === 'acme');
check('token is null when auth disabled', created.token === null);

// 2. Ensure is idempotent (no duplicate + still one project)
r = await app.inject({ method: 'POST', url: '/projects', payload: { slug: 'acme', name: 'Acme 2' } });
check('ensure returns same project (idempotent)', r.json().project?.id === created.project?.id);

// 3. List projects
r = await app.inject({ method: 'GET', url: '/projects' });
const list = r.json();
check('list contains acme', Array.isArray(list) && list.some((p) => p.slug === 'acme'));

// 4. Get by slug
r = await app.inject({ method: 'GET', url: '/projects/acme' });
check('get /projects/acme -> 200', r.statusCode === 200 && r.json().name === 'Acme');

// 5. The project scope is the category/scope namespace for memory
r = await app.inject({ method: 'POST', url: '/memory', payload: { content: 'project fact', category: 'acme' } });
check('write memory into project scope -> 200', r.statusCode === 200);
r = await app.inject({ method: 'POST', url: '/context/assemble', payload: { scope: 'acme' } });
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
