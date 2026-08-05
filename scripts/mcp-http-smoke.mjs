// MCP-over-HTTP smoke: connect an MCP client to the running agentdox server's /mcp
// with a real bearer token, then exercise tools + verify scope RBAC.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const MCP = 'http://localhost:3003/mcp';
const KC = 'http://localhost:8090/realms/agentdox';
const pass = (n, ok) => console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`);

// get drew's OIDC token (grants: demo:write ashlands:read)
const tr = await fetch(`${KC}/protocol/openid-connect/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: 'grant_type=password&client_id=agentdox-server&client_secret=agentdox-server-dev-secret&username=drew&password=demo123',
});
const tj = await tr.json();
pass('got OIDC token', !!tj.access_token);
const at = tj.access_token;

const transport = new StreamableHTTPClientTransport(new URL(MCP), {
  requestInit: { headers: { authorization: `Bearer ${at}` } },
});
const client = new Client({ name: 'mcp-http-smoke', version: '1.0.0' });
await client.connect(transport);

const tools = await client.listTools();
pass(`list tools (${tools.tools.length})`, tools.tools.length >= 13);
pass('has memory_add + context_assemble + project_ensure',
  ['memory_add', 'context_assemble', 'project_ensure'].every((n) => tools.tools.some((t) => t.name === n)));

// memory_add in demo (write) -> ok
const add = await client.callTool({ name: 'memory_add', arguments: { content: `http-mcp ${Date.now()}`, category: 'demo' } });
pass('memory_add demo (write)', !add.isError && /\bStored memory\b/.test(add.content[0]?.text ?? ''));

// memory_add in ashlands (read-only) -> denied
const denyAdd = await client.callTool({ name: 'memory_add', arguments: { content: 'no', category: 'ashlands' } });
pass('memory_add ashlands denied (read-only)', denyAdd.isError && /forbidden/.test(denyAdd.content[0]?.text ?? ''));

// context_assemble demo -> ok
const ctx = await client.callTool({ name: 'context_assemble', arguments: { scope: 'demo' } });
pass('context_assemble demo', !ctx.isError && ctx.content.length > 0);

// context_assemble ashlands -> ok (read) but not missing-scope ->  should also deny an unknown scope
const miss = await client.callTool({ name: 'context_assemble', arguments: { scope: 'missing-scope' } });
pass('context_assemble unknown scope denied', miss.isError && /forbidden/.test(miss.content[0]?.text ?? ''));

await client.close();
console.log('done');
