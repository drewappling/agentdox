import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AgentDox } from '@agentdox/core';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.AGENTDOX_DB ?? resolve(here, '../../..', 'data', 'agentdox.db');
mkdirSync(resolve(here, '../../..', 'data'), { recursive: true });
const dox = new AgentDox(dbPath);

const server = new McpServer(
  { name: 'agentdox', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

/** Build an MCP text content block. */
const block = (text: string) => ({ type: 'text' as const, text });
const ok = (text: string, structuredContent?: unknown) =>
  structuredContent === undefined
    ? { content: [block(text)] }
    : { content: [block(text)], structuredContent: structuredContent as Record<string, unknown> };

// ---------- Memory ----------
server.registerTool(
  'memory_add',
  {
    title: 'Add memory',
    description: 'Store a durable fact in agent memory. Keep content compact and high-signal. category acts as the scope (e.g. a project or agent name).',
    inputSchema: {
      content: z.string().describe('The fact to remember'),
      category: z.string().optional().describe('Scope/category (e.g. project or agent name)'),
      target: z.string().optional().describe('Sub-scope, e.g. what the fact is about'),
      importance: z.number().min(0).max(1).optional().describe('0..1; higher survives eviction'),
      tags: z.array(z.string()).optional(),
    },
  },
  async ({ content, category, target, importance, tags }) => {
    const entry = dox.memory.create({ content, category, target, importance: importance ?? 0.5, tags: tags ?? [] });
    return ok(`Stored memory ${entry.id}`, entry);
  },
);

server.registerTool(
  'memory_search',
  {
    title: 'Search memory',
    description: 'Search stored memory by relevance + importance. Returns ranked hits in a scope/category.',
    inputSchema: {
      query: z.string(),
      category: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  },
  async ({ query, category, limit }) => {
    const hits = dox.memory.search(query, { category, limit: limit ?? 20 });
    const text = hits.length
      ? hits.map((h, i) => `${i + 1}. [${h.score.toFixed(2)}] ${h.entry.content}`).join('\n')
      : '(no memory matches)';
    return ok(text, hits.map((h) => ({ entry: h.entry, score: h.score })));
  },
);

server.registerTool(
  'memory_list',
  {
    title: 'List memory',
    description: 'List memory entries in a scope/category, ordered by importance.',
    inputSchema: { category: z.string().optional(), target: z.string().optional(), limit: z.number().int().min(1).max(200).optional() },
  },
  async ({ category, target, limit }) => {
    const entries = dox.memory.list({ category, target, limit });
    return ok(entries.map((e) => `[${e.importance}] ${e.content}`).join('\n') || '(no memory)', entries);
  },
);

server.registerTool(
  'memory_remove',
  {
    title: 'Remove memory',
    description: 'Delete a memory entry by id.',
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    const removed = dox.memory.remove(id);
    return ok(removed ? `Removed ${id}` : `Not found: ${id}`);
  },
);

server.registerTool(
  'memory_update',
  {
    title: 'Update memory',
    description: 'Patch an existing memory entry (content, category, target, importance, tags).',
    inputSchema: {
      id: z.string(),
      content: z.string().optional(),
      category: z.string().optional(),
      target: z.string().optional(),
      importance: z.number().min(0).max(1).optional(),
      tags: z.array(z.string()).optional(),
    },
  },
  async (patch) => {
    const { id, tags, ...rest } = patch;
    const entry = dox.memory.update(id, { ...rest, ...(tags !== undefined ? { tags } : {}) });
    if (!entry) return { isError: true, content: [block(`Not found: ${id}`)] };
    return ok(`Updated ${id}`, entry);
  },
);

// ---------- Docs ----------
server.registerTool(
  'docs_write',
  {
    title: 'Write doc',
    description: 'Create a new markdown documentation entry (versioned). slug must be unique.',
    inputSchema: {
      slug: z.string(),
      title: z.string(),
      content: z.string(),
      scope: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
  },
  async ({ slug, title, content, scope, tags }) => {
    const doc = dox.docs.create({ slug, title, content, scope, tags: tags ?? [] });
    return ok(`Created doc ${doc.id} (v${doc.version})`, doc);
  },
);

server.registerTool(
  'docs_read',
  {
    title: 'Read doc',
    description: 'Read a doc by id or slug.',
    inputSchema: { id: z.string().optional(), slug: z.string().optional() },
  },
  async ({ id, slug }) => {
    const doc = id ? dox.docs.get(id) : slug ? dox.docs.getBySlug(slug) : null;
    if (!doc) return { isError: true, content: [block('doc not found')] };
    return ok(`# ${doc.title} (v${doc.version})\n\n${doc.content}`, doc);
  },
);

server.registerTool(
  'docs_search',
  {
    title: 'Search docs',
    description: 'Search documentation by keyword, optionally within a scope.',
    inputSchema: { query: z.string(), scope: z.string().optional(), limit: z.number().int().min(1).max(50).optional() },
  },
  async ({ query, scope, limit }) => {
    const docs = dox.docs.search(query, { scope, limit: limit ?? 10 });
    return ok(docs.map((d) => `- ${d.slug} (v${d.version}): ${d.title}`).join('\n') || '(no docs match)', docs);
  },
);

server.registerTool(
  'docs_update',
  {
    title: 'Update doc',
    description: 'Update a doc. Creates a new version snapshot.',
    inputSchema: { id: z.string(), title: z.string().optional(), content: z.string().optional(), tags: z.array(z.string()).optional() },
  },
  async ({ id, title, content, tags }) => {
    const doc = dox.docs.update(id, { title, content, tags });
    if (!doc) return { isError: true, content: [block(`Not found: ${id}`)] };
    return ok(`Updated ${id} → v${doc.version}`, doc);
  },
);

// ---------- Sessions ----------
server.registerTool(
  'session_start',
  {
    title: 'Start session',
    description: 'Create a new conversation session in a scope/topic.',
    inputSchema: { scope: z.string(), title: z.string().optional() },
  },
  async ({ scope, title }) => {
    const s = dox.sessions.create({ scope, title });
    return ok(`Session ${s.id}`, s);
  },
);

server.registerTool(
  'session_append',
  {
    title: 'Append message',
    description: 'Append a message to a session (role: user|assistant|system|tool).',
    inputSchema: { session_id: z.string(), role: z.enum(['user', 'assistant', 'system', 'tool']), content: z.string() },
  },
  async ({ session_id, role, content }) => {
    const msg = dox.sessions.append(session_id, { role, content });
    if (!msg) return { isError: true, content: [block(`Session not found: ${session_id}`)] };
    return ok(`Appended ${role} message`, msg);
  },
);

// ---------- Context ----------
server.registerTool(
  'context_assemble',
  {
    title: 'Assemble context',
    description: 'Build the prompt-ready context block for a scope: relevant memory + docs + recent conversation. Compute on demand.',
    inputSchema: {
      scope: z.string(),
      query: z.string().optional().describe('Task/query to bias relevance'),
      memory_limit: z.number().int().min(0).max(100).optional(),
      docs_limit: z.number().int().min(0).max(20).optional(),
      session_limit: z.number().int().min(0).max(200).optional(),
    },
  },
  async ({ scope, query, memory_limit, docs_limit, session_limit }) => {
    const slice = dox.context.assemble({
      scope,
      query,
      memoryLimit: memory_limit,
      docsLimit: docs_limit,
      sessionLimit: session_limit,
    });
    return ok(slice.prompt, {
      chars: slice.chars,
      memoryCount: slice.memory.length,
      docsCount: slice.docs.length,
      sessionMessages: slice.sessionMessages.length,
    });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[agentdox-mcp] server ready — tools: memory_add, memory_search, memory_list, memory_remove, memory_update, docs_write, docs_read, docs_search, docs_update, session_start, session_append, context_assemble');
