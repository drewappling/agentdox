import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AgentDox } from '@agentdox/core';
import { roleAtLeast, type Principal, type Role } from '@agentdox/types';
import { z } from 'zod';

const block = (text: string) => ({ type: 'text' as const, text });
/**
 * MCP requires `structuredContent` to be a JSON *object*. The list/search tools
 * naturally produce arrays, and handing one over fails client-side schema
 * validation at runtime ("array vs record") — which the old
 * `as Record<string, unknown>` cast hid at compile time. Wrap arrays in
 * `{ items }` so every tool stays valid regardless of what it returns.
 */
const ok = (text: string, structuredContent?: unknown) => {
  if (structuredContent === undefined) return { content: [block(text)] };
  const structured = Array.isArray(structuredContent)
    ? { items: structuredContent }
    : (structuredContent as Record<string, unknown>);
  return { content: [block(text)], structuredContent: structured };
};
const deny = (msg: string) => ({ isError: true as const, content: [block(msg)] });

/**
 * Does the principal hold at least `role` on `scope` (or a wildcard grant)?
 * `null` principal == auth-disabled / local => full access (stdio path).
 */
const can = (p: Principal | null, scope: string, role: Role): boolean => {
  if (!p) return true;
  const g = p.grants[scope] ?? p.grants['*'] ?? 'none';
  return roleAtLeast(g, role);
};
const GROUP_MSG = (scope: string, role: Role) => `forbidden: no ${role} access to scope '${scope}'`;

/**
 * Build an MCP server backed by `dox`, with every tool scoped-RBAC-guarded by `principal`.
 * Used both by the stdio entry (`principal = null` => local full access) and by the HTTP
 * transport (authenticated principal per connection). All tools share one store.
 */
export function createMcpServer(dox: AgentDox, principal: Principal | null): McpServer {
  const server = new McpServer(
    { name: 'agentdox', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // ---------- Projects ----------
  server.registerTool(
    'project_ensure',
    {
      title: 'Ensure project',
      description: 'Create or get an agent workspace (project). The slug becomes the scope namespace for memory/docs/sessions. Call this on connect so subsequent memory/docs are scoped to your project.',
      inputSchema: {
        slug: z.string().describe('Stable identifier, also the scope (e.g. acme)'),
        name: z
          .string()
          .optional()
          .describe('Human-friendly project name. Only used if the project does not exist yet; defaults to the slug.'),
        description: z.string().optional(),
      },
    },
    async ({ slug, name, description }) => {
      const existing = dox.projects.get(slug);
      if (existing && !can(principal, existing.slug, 'read')) return deny(GROUP_MSG(slug, 'read'));
      const project = dox.projects.ensure({ slug, name, description, ownerSub: principal?.sub });
      return ok(`Project ${project.slug} (${project.name})`, project);
    },
  );

  server.registerTool(
    'project_list',
    {
      title: 'List projects',
      description: 'List agent workspaces you can access (granted or owned).',
      inputSchema: {},
    },
    async () => {
      const all = dox.projects.list();
      const projects = principal
        ? all.filter((p) => can(principal, p.slug, 'read') || p.ownerSub === principal.sub)
        : all;
      return ok(projects.map((p) => `- ${p.slug}: ${p.name}`).join('\n') || '(no projects)', projects);
    },
  );

  // ---------- Memory ----------
  server.registerTool(
    'memory_add',
    {
      title: 'Add memory',
      description: 'Store a durable fact scoped to a project (category == scope). Keep content compact and high-signal.',
      inputSchema: {
        content: z.string().describe('The fact to remember'),
        category: z.string().optional().describe('Scope/project (e.g. acme)'),
        target: z.string().optional(),
        importance: z.number().min(0).max(1).optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    async ({ content, category, target, importance, tags }) => {
      const scope = category ?? '';
      if (!can(principal, scope, 'write')) return deny(GROUP_MSG(scope, 'write'));
      const entry = dox.memory.create({ content, category, target, importance: importance ?? 0.5, tags: tags ?? [] });
      return ok(`Stored memory ${entry.id}`, entry);
    },
  );

  server.registerTool(
    'memory_search',
    {
      title: 'Search memory',
      description: 'Search memory by relevance, within a scope/category.',
      inputSchema: {
        query: z.string(),
        category: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ query, category, limit }) => {
      if (category && !can(principal, category, 'read')) return deny(GROUP_MSG(category, 'read'));
      const hits = (await dox.memory.search(query, { category, limit: limit ?? 20 }))
        .filter((h) => can(principal, h.entry.category ?? '', 'read'));
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
      if (category && !can(principal, category, 'read')) return deny(GROUP_MSG(category, 'read'));
      const entries = dox.memory.list({ category, target, limit }).filter((e) => can(principal, e.category ?? '', 'read'));
      return ok(entries.map((e) => `[${e.importance}] ${e.content}`).join('\n') || '(no memory)', entries);
    },
  );

  server.registerTool(
    'memory_remove',
    {
      title: 'Remove memory',
      description: 'Delete a memory entry by id (needs admin on its scope).',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const entry = dox.memory.get(id);
      if (!entry) return ok('Not found: ' + id);
      if (!can(principal, entry.category ?? '', 'admin')) return deny(GROUP_MSG(entry.category ?? '', 'admin'));
      dox.memory.remove(id);
      return ok(`Removed ${id}`);
    },
  );

  server.registerTool(
    'memory_update',
    {
      title: 'Update memory',
      description: 'Patch a memory entry (needs write on its scope).',
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
      const existing = dox.memory.get(id);
      if (!existing) return { isError: true, content: [block(`Not found: ${id}`)] };
      if (!can(principal, existing.category ?? '', 'write')) return deny(GROUP_MSG(existing.category ?? '', 'write'));
      const entry = dox.memory.update(id, { ...rest, ...(tags !== undefined ? { tags } : {}) });
      return ok(`Updated ${id}`, entry);
    },
  );

  // ---------- Docs ----------
  server.registerTool(
    'docs_write',
    {
      title: 'Write doc',
      description: 'Create a versioned markdown doc in a scope/project (slug unique).',
      inputSchema: {
        slug: z.string(),
        title: z.string(),
        content: z.string(),
        scope: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    async ({ slug, title, content, scope, tags }) => {
      const sc = scope ?? '';
      if (!can(principal, sc, 'write')) return deny(GROUP_MSG(sc, 'write'));
      const doc = dox.docs.create({ slug, title, content, scope, tags: tags ?? [] });
      return ok(`Created doc ${doc.id} (v${doc.version})`, doc);
    },
  );

  server.registerTool(
    'docs_read',
    {
      title: 'Read doc',
      description: 'Read a doc by id or slug (needs read on its scope).',
      inputSchema: { id: z.string().optional(), slug: z.string().optional() },
    },
    async ({ id, slug }) => {
      const doc = id ? dox.docs.get(id) : slug ? dox.docs.getBySlug(slug) : null;
      if (!doc) return { isError: true, content: [block('doc not found')] };
      if (!can(principal, doc.scope ?? '', 'read')) return deny(GROUP_MSG(doc.scope ?? '', 'read'));
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
      if (scope && !can(principal, scope, 'read')) return deny(GROUP_MSG(scope, 'read'));
      const docs = (await dox.docs.search(query, { scope, limit: limit ?? 10 })).filter((d) => can(principal, d.scope ?? '', 'read'));
      return ok(docs.map((d) => `- ${d.slug} (v${d.version}): ${d.title}`).join('\n') || '(no docs match)', docs);
    },
  );

  server.registerTool(
    'docs_passages',
    {
      title: 'Search doc passages',
      description:
        'Search documentation and get back the matching PASSAGES rather than whole documents. Prefer this over docs_search when you want the part of a doc that answers a question: a long doc returned whole is truncated, and the truncation is rarely the relevant part. Each hit carries the doc slug and heading breadcrumb, so you can docs_read the full document when a passage is not enough.',
      inputSchema: {
        query: z.string(),
        scope: z.string().optional().describe('Project scope (e.g. acme)'),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ query, scope, limit }) => {
      if (scope && !can(principal, scope, 'read')) return deny(GROUP_MSG(scope, 'read'));
      const hits = await dox.docs.searchChunks(query, { scope, limit: limit ?? 8 });
      // Chunks carry their doc's scope, so an unscoped query still filters per-hit.
      const readable = hits.filter((h) => {
        const doc = dox.docs.get(h.docId);
        return can(principal, doc?.scope ?? '', 'read');
      });
      const text = readable.length
        ? readable
            .map((h) => `### ${h.title} — ${h.slug}${h.heading ? ` § ${h.heading}` : ''}\n${h.content}`)
            .join('\n\n')
        : '(no passages match)';
      return ok(text, readable);
    },
  );

  server.registerTool(
    'docs_update',
    {
      title: 'Update doc',
      description: 'Update a doc (creates a new version snapshot; needs write on its scope).',
      inputSchema: { id: z.string(), title: z.string().optional(), content: z.string().optional(), tags: z.array(z.string()).optional() },
    },
    async ({ id, title, content, tags }) => {
      const existing = dox.docs.get(id);
      if (!existing) return { isError: true, content: [block(`Not found: ${id}`)] };
      if (!can(principal, existing.scope ?? '', 'write')) return deny(GROUP_MSG(existing.scope ?? '', 'write'));
      const doc = dox.docs.update(id, { title, content, tags });
      return ok(`Updated ${id} → v${doc?.version}`, doc);
    },
  );

  // ---------- Retrieval index ----------
  server.registerTool(
    'index_stats',
    {
      title: 'Retrieval index stats',
      description:
        'How much of a scope is indexed for search: memory entries and doc passages, and how many carry embeddings. Use it when search results look stale or thin — "embedded" far below "total" means the vector half of retrieval is not covering this scope yet.',
      inputSchema: { scope: z.string().optional() },
    },
    async ({ scope }) => {
      if (scope && !can(principal, scope, 'read')) return deny(GROUP_MSG(scope, 'read'));
      const stats = dox.index.stats(scope);
      const line = (label: string, x: { total: number; embedded: number }) =>
        `${label}: ${x.total} indexed, ${x.embedded} embedded`;
      const provider = stats.provider ? `${stats.provider} (${stats.model})` : 'none — lexical-only';
      return ok(`${line('memory', stats.memory)}
${line('passages', stats.chunks)}
embeddings: ${provider}`, stats);
    },
  );

  server.registerTool(
    'index_rebuild',
    {
      title: 'Rebuild retrieval index',
      description:
        'Re-chunk and re-index a scope, then embed anything missing. Needed only after rows are written straight into the database, or to force a refresh; ordinary writes index themselves.',
      inputSchema: { scope: z.string().optional(), embed: z.boolean().optional() },
    },
    async ({ scope, embed }) => {
      // Rebuilding is global (it re-chunks every doc), so an unscoped call needs wildcard admin.
      const required = scope ?? '*';
      if (!can(principal, required, 'admin')) return deny(GROUP_MSG(required, 'admin'));
      const lexical = dox.index.rebuildLexical();
      const embedded = embed === false ? null : await dox.index.backfillEmbeddings({ scope });
      return ok(
        `Rebuilt ${lexical.memory} memory + ${lexical.chunks} passages` +
          (embedded ? `; embedded ${embedded.embedded}${embedded.error ? ` (stopped: ${embedded.error})` : ''}` : ''),
        { lexical, embedded },
      );
    },
  );

  // ---------- Sessions ----------
  server.registerTool(
    'session_start',
    {
      title: 'Start session',
      description: 'Create a conversation session in a scope/project.',
      inputSchema: { scope: z.string(), title: z.string().optional() },
    },
    async ({ scope, title }) => {
      if (!can(principal, scope, 'write')) return deny(GROUP_MSG(scope, 'write'));
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
      const s = dox.sessions.get(session_id);
      if (!s) return { isError: true, content: [block(`Session not found: ${session_id}`)] };
      if (!can(principal, s.scope, 'write')) return deny(GROUP_MSG(s.scope, 'write'));
      const msg = dox.sessions.append(session_id, { role, content });
      return ok(`Appended ${role} message`, msg);
    },
  );

  // ---------- Context ----------
  server.registerTool(
    'context_assemble',
    {
      title: 'Assemble context',
      description: 'Build the prompt-ready context block for a scope: relevant memory + docs + recent conversation.',
      inputSchema: {
        scope: z.string(),
        query: z.string().optional(),
        memory_limit: z.number().int().min(0).max(100).optional(),
        docs_limit: z.number().int().min(0).max(20).optional(),
        session_limit: z.number().int().min(0).max(200).optional(),
      },
    },
    async ({ scope, query, memory_limit, docs_limit, session_limit }) => {
      if (!can(principal, scope, 'read')) return deny(GROUP_MSG(scope, 'read'));
      const slice = await dox.context.assemble({
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

  // ---------- Historic project brief ----------
  server.registerTool(
    'context_brief',
    {
      title: 'Read project brief',
      description:
        'Read the historic, cumulative on-ramp for a project/scope: overview, repo layout & tooling, ' +
        'code style, build & test, asset conventions, gotchas, and the decision log. Read this when first ' +
        'starting on a project to onboard without rediscovering decisions or conventions.',
      inputSchema: { scope: z.string() },
    },
    async ({ scope }) => {
      if (!can(principal, scope, 'read')) return deny(GROUP_MSG(scope, 'read'));
      const brief = dox.context.getBrief(scope);
      if (!brief) {
        return ok(
          `No historic brief yet for '${scope}'. Run context_brief_seed to build one from current memory/docs, ` +
            `or record decisions with context_brief_record as they're made.`,
          {},
        );
      }
      const lines = [
        `# Project brief: ${scope}`,
        `(updated ${brief.updatedAt})`,
        '',
        `## Overview`,
        brief.overview || '(none)',
        '',
        `## Repo layout & tooling`,
        brief.repoLayout || '(none)',
        '',
        `## Code style`,
        brief.codeStyle || '(none)',
        '',
        `## Build & test`,
        brief.buildTest || '(none)',
        '',
        `## Asset / art conventions`,
        brief.assetConventions || '(none)',
        '',
        `## Gotchas`,
        brief.gotchas || '(none)',
        '',
        `## Decision log`,
        ...(brief.decisionLog.length
          ? brief.decisionLog.map((d) => `- [${d.at}] ${d.title}: ${d.decision}${d.rationale ? ` (${d.rationale})` : ''}`)
          : ['(none recorded yet)']),
      ];
      return ok(lines.join('\n'), { decisionCount: brief.decisionLog.length });
    },
  );

  server.registerTool(
    'context_brief_record',
    {
      title: 'Record project decision',
      description:
        'Append a decision/convention to a project\'s historic brief (title, the decision, optional rationale). ' +
        'Record decisions and conventions as they are made so the brief is the cumulative history a new agent reads.',
      inputSchema: { scope: z.string(), title: z.string(), decision: z.string(), rationale: z.string().optional() },
    },
    async ({ scope, title, decision, rationale }) => {
      if (!can(principal, scope, 'write')) return deny(GROUP_MSG(scope, 'write'));
      if (!title || !decision) return { isError: true, content: [block('title and decision are required')] };
      const brief = dox.context.addDecision(scope, { title, decision, rationale });
      return ok(`Recorded decision in '${scope}' (${brief.decisionLog.length} total)`, { decisionCount: brief.decisionLog.length });
    },
  );

  server.registerTool(
    'context_brief_seed',
    {
      title: 'Seed project brief',
      description: 'Build/seed a project brief from its current top memory and docs (keeps any existing decision log).',
      inputSchema: { scope: z.string() },
    },
    async ({ scope }) => {
      if (!can(principal, scope, 'write')) return deny(GROUP_MSG(scope, 'write'));
      const brief = dox.context.seedBrief(scope);
      return ok(`Seeded brief for '${scope}' from current memory/docs`, { decisionCount: brief.decisionLog.length });
    },
  );

  return server;
}
