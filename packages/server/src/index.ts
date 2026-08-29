import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import { AgentDox } from '@agentdox/core';
import { createMcpServer } from '@agentdox/mcp';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { roleAtLeast, type ContextRequest, type Doc, type MemoryEntry, type Principal, type Role } from '@agentdox/types';
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { authenticate, guard, loadAuthContext, type AuthContext } from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');

/** Per-request resolved principal (set once by the global onRequest hook). */
const principals = new WeakMap<FastifyRequest, Principal | null>();
const principalOf = (req: FastifyRequest): Principal | null => principals.get(req) ?? null;

export interface BuildOptions {
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
  authEnabled?: boolean;
}

export function buildApp(opts: BuildOptions = {}): { app: FastifyInstance; dox: AgentDox; auth: AuthContext } {
  const env = opts.env ?? process.env;
  const dbPath = opts.dbPath ?? resolve(repoRoot, 'data', 'agentdox.db');
  mkdirSync(resolve(repoRoot, 'data'), { recursive: true });

  const dox = new AgentDox(dbPath);
  // Account for env-injected auth flag (used by tests) plus process env.
  const mergedEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  const auth: AuthContext = {
    enabled: opts.authEnabled ?? mergedEnv.AGENTDOX_AUTH_ENABLED === 'true',
    chain: null,
    pat: null,
  };
  if (auth.enabled) void loadAuthContext(dox.pat, mergedEnv).then((ctx) => {
    auth.chain = ctx.chain;
    auth.pat = ctx.pat;
  });

  // Admin bootstrap: seed a PAT from env so the first token can be minted out-of-band.
  const adminToken = mergedEnv.AGENTDOX_ADMIN_TOKEN;
  if (auth.enabled && adminToken && !dox.pat.existsByRawToken(adminToken)) {
    dox.pat.issue({ name: 'bootstrap-admin', grants: { '*': 'admin' }, rawToken: adminToken });
  }

  const app = Fastify({ logger: true });
  app.register(cors, { origin: true });

  // Preserve raw JSON bodies (needed for the MCP streamable transport) while keeping the
  // default parsed-object behavior on `request.body` for all other routes.
  app.addContentTypeParser(['application/json', 'text/plain', 'application/json-rpc'], { parseAs: 'buffer' }, (request, body, done) => {
    const raw = body.toString('utf8');
    (request as unknown as { rawBody?: string }).rawBody = raw;
    try {
      done(null, JSON.parse(raw));
    } catch {
      done(null, undefined);
    }
  });

  // Resolve the caller's principal (without rejecting) so handlers can guard.
  app.addHook('onRequest', async (req) => {
    if (auth.enabled && auth.chain) {
      principals.set(req, await authenticate(req, auth));
    } else {
      principals.set(req, null);
    }
  });

  app.get('/health', async () => ({ ok: true, service: 'agentdox', auth: auth.enabled, db: dbPath }));

  // ---- PAT management (requires wildcard admin) ----
  const adminOnly = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!guard(req, reply, auth, principalOf(req), undefined, 'admin')) return false;
    const p = principalOf(req);
    if (!p || !p.grants['*'] || p.grants['*'] !== 'admin') {
      void reply.code(403).send({ error: 'forbidden', message: 'admin required' });
      return false;
    }
    return true;
  };

  app.get('/auth/tokens', async (req, reply) => {
    if (!adminOnly(req, reply)) return;
    return dox.pat.list();
  });

  app.post<{ Body: { name?: string; grants?: Record<string, Role>; ttlMs?: number } }>('/auth/tokens', async (req, reply) => {
    if (!adminOnly(req, reply)) return;
    const grants = req.body?.grants ?? { '*': 'admin' };
    const issued = dox.pat.issue({ name: req.body?.name, grants, ttlMs: req.body?.ttlMs });
    return { id: issued.id, token: issued.token, expiresAt: issued.expiresAt, grants };
  });

  app.delete('/auth/tokens/:id', async (req, reply) => {
    if (!adminOnly(req, reply)) return;
    if (!dox.pat.revoke((req.params as { id: string }).id)) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  // ---- Retrieval index ----
  app.get('/index/stats', async (req, reply) => {
    const scope = (req.query as { scope?: string }).scope;
    if (scope && !guard(req, reply, auth, principalOf(req), scope, 'read')) return;
    if (!scope && !guard(req, reply, auth, principalOf(req), undefined, 'read')) return;
    return dox.index.stats(scope);
  });

  /**
   * Rebuild the lexical index and (optionally) embed what is missing. Needed after importing
   * rows straight into SQLite, and after upgrading a store that predates the index tables.
   */
  app.post<{ Body: { scope?: string; embed?: boolean; limit?: number } }>('/index/rebuild', async (req, reply) => {
    if (!adminOnly(req, reply)) return;
    const lexical = dox.index.rebuildLexical();
    const body = req.body ?? {};
    const embedded =
      body.embed === false ? null : await dox.index.backfillEmbeddings({ scope: body.scope, limit: body.limit });
    return { lexical, embedded, stats: dox.index.stats(body.scope) };
  });

  // ---- Projects (agent-provisioned workspaces; slug == scope namespace) ----
  app.get('/projects', async (req, reply) => {
    const projects = dox.projects.list();
    if (!auth.enabled) return projects;
    const p = validatePrincipal(principalOf(req));
    return projects.filter((pr) => scopeGrant(p, pr.slug, 'read') || pr.ownerSub === p.sub);
  });

  app.get('/projects/:slug', async (req, reply) => {
    const pr = dox.projects.get((req.params as { slug: string }).slug);
    if (!pr) return reply.code(404).send({ error: 'not_found' });
    if (!guard(req, reply, auth, principalOf(req), pr.slug, 'read')) return;
    return pr;
  });

  app.post<{ Body: { slug: string; name: string; description?: string } }>('/projects', async (req, reply) => {
    const b = req.body ?? ({} as { slug?: string; name?: string; description?: string });
    if (!b.slug || !b.name) return reply.code(400).send({ error: 'slug_name_required' });
    const existing = dox.projects.get(b.slug);
    if (existing) {
      if (!guard(req, reply, auth, principalOf(req), existing.slug, 'read')) return;
      return { project: existing, token: null, expiresAt: null };
    }
    const p = principalOf(req);
    if (auth.enabled && !p) return reply.code(401).send({ error: 'unauthorized', message: 'authenticate to create a project' });
    const project = dox.projects.ensure({ slug: b.slug, name: b.name, description: b.description, ownerSub: p?.sub });
    // First claim of a brand-new project -> hand the agent a scoped PAT (shown once).
    let token: string | null = null;
    let expiresAt: number | null = null;
    if (auth.enabled && p && !scopeGrant(p, project.slug, 'write')) {
      const ttlMs = 90 * 24 * 3600 * 1000; // 90 days
      const issued = dox.pat.issue({ name: `project:${project.slug}`, grants: { [project.slug]: 'admin' }, ttlMs });
      token = issued.token;
      expiresAt = issued.expiresAt ?? null;
    }
    return { project, token, expiresAt };
  });

  app.delete('/projects/:slug', async (req, reply) => {
    const pr = dox.projects.get((req.params as { slug: string }).slug);
    if (!pr) return reply.code(404).send({ error: 'not_found' });
    if (auth.enabled) {
      const p = principalOf(req);
      if (!p) return reply.code(401).send({ error: 'unauthorized' });
      const owned = typeof pr.ownerSub === 'string' && pr.ownerSub === p.sub;
      if (!scopeGrant(p, pr.slug, 'admin') && p.grants['*'] !== 'admin' && !owned) {
        return reply.code(403).send({ error: 'forbidden', message: 'admin or owner required to delete project' });
      }
    }
    // Cascade-remove the project row and all its scoped data, then invalidate any selected UI state.
    dox.projects.remove(pr.slug);
    return { ok: true, removed: pr.slug };
  });

  // ---- Memory ----
  app.get('/memory', async (req, reply) => {
    const q = req.query as { category?: string; target?: string; tag?: string; limit?: string };
    const p = principalOf(req);
    if (q.category) {
      if (!guard(req, reply, auth, p, q.category, 'read')) return;
    } else if (auth.enabled && !guard(req, reply, auth, p, undefined, 'read')) {
      return;
    }
    const entries = dox.memory.list({
      category: q.category,
      target: q.target,
      tag: q.tag,
      limit: q.limit ? parseInt(q.limit, 10) : undefined,
    });
    if (!auth.enabled) return entries;
    // Filter down to the caller's readable scopes when listing without a category filter.
    return entries.filter((e) => scopeGrant(validatePrincipal(p), e.category ?? '', 'read'));
  });

  app.get('/memory/search', async (req, reply) => {
    const q = req.query as { q?: string; category?: string; target?: string; tag?: string; limit?: string };
    if (!q.q) return [];
    if (q.category && !guard(req, reply, auth, principalOf(req), q.category, 'read')) return;
    return dox.memory.search(q.q, {
      category: q.category,
      target: q.target,
      tag: q.tag,
      limit: q.limit ? parseInt(q.limit, 10) : undefined,
    });
  });

  app.get('/memory/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const entry = dox.memory.get(id);
    if (!entry) return reply.code(404).send({ error: 'not_found' });
    if (!guard(req, reply, auth, principalOf(req), entry.category ?? '', 'read')) return;
    return entry;
  });

  app.post<{ Body: Partial<MemoryEntry> }>('/memory', async (req, reply) => {
    const body = req.body;
    if (!body?.content) return reply.code(400).send({ error: 'content_required' });
    if (!guard(req, reply, auth, principalOf(req), body.category ?? '', 'write')) return;
    return dox.memory.create({
      content: body.content,
      category: body.category,
      target: body.target,
      importance: body.importance ?? 0.5,
      tags: body.tags ?? [],
      source: body.source,
    });
  });

  app.patch<{ Params: { id: string }; Body: Partial<Omit<MemoryEntry, 'id' | 'createdAt'>> }>(
    '/memory/:id',
    async (req, reply) => {
      const existing = dox.memory.get(req.params.id);
      if (!existing) return reply.code(404).send({ error: 'not_found' });
      if (!guard(req, reply, auth, principalOf(req), existing.category ?? '', 'write')) return;
      const entry = dox.memory.update(req.params.id, req.body);
      if (!entry) return reply.code(404).send({ error: 'not_found' });
      return entry;
    },
  );

  app.delete('/memory/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = dox.memory.get(id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    if (!guard(req, reply, auth, principalOf(req), existing.category ?? '', 'admin')) return;
    return { ok: dox.memory.remove(id) };
  });

  // ---- Docs ----
  app.get('/docs', async (req, reply) => {
    const q = req.query as { scope?: string; tag?: string; limit?: string };
    if (q.scope && !guard(req, reply, auth, principalOf(req), q.scope, 'read')) return;
    return dox.docs.list({ scope: q.scope, tag: q.tag, limit: q.limit ? parseInt(q.limit, 10) : undefined });
  });

  app.get('/docs/search', async (req, reply) => {
    const q = req.query as { q?: string; scope?: string; limit?: string };
    if (!q.q) return [];
    if (q.scope && !guard(req, reply, auth, principalOf(req), q.scope, 'read')) return;
    return dox.docs.search(q.q, { scope: q.scope, limit: q.limit ? parseInt(q.limit, 10) : undefined });
  });

  app.get('/docs/slug/:slug', async (req, reply) => {
    const doc = dox.docs.getBySlug((req.params as { slug: string }).slug);
    if (!doc) return reply.code(404).send({ error: 'not_found' });
    if (!guard(req, reply, auth, principalOf(req), doc.scope ?? '', 'read')) return;
    return doc;
  });

  app.get('/docs/:id', async (req, reply) => {
    const doc = dox.docs.get((req.params as { id: string }).id);
    if (!doc) return reply.code(404).send({ error: 'not_found' });
    if (!guard(req, reply, auth, principalOf(req), doc.scope ?? '', 'read')) return;
    return doc;
  });

  app.get('/docs/:id/history', async (req, reply) => {
    const { id } = req.params as { id: string };
    const doc = dox.docs.get(id);
    if (!doc) return reply.code(404).send({ error: 'not_found' });
    if (!guard(req, reply, auth, principalOf(req), doc.scope ?? '', 'read')) return;
    return dox.docs.history(id);
  });

  app.post<{ Body: Partial<Doc> & { slug: string; title: string; content: string } }>('/docs', async (req, reply) => {
    const b = req.body;
    if (!b?.slug || !b.title || !b.content) return reply.code(400).send({ error: 'slug_title_content_required' });
    if (!guard(req, reply, auth, principalOf(req), b.scope ?? '', 'write')) return;
    return dox.docs.create({ slug: b.slug, title: b.title, content: b.content, tags: b.tags ?? [], scope: b.scope });
  });

  app.patch<{ Params: { id: string }; Body: Partial<Pick<Doc, 'title' | 'content' | 'tags' | 'scope' | 'slug'>> }>(
    '/docs/:id',
    async (req, reply) => {
      const existing = dox.docs.get(req.params.id);
      if (!existing) return reply.code(404).send({ error: 'not_found' });
      if (!guard(req, reply, auth, principalOf(req), existing.scope ?? '', 'write')) return;
      const doc = dox.docs.update(req.params.id, req.body);
      if (!doc) return reply.code(404).send({ error: 'not_found' });
      return doc;
    },
  );

  app.delete('/docs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = dox.docs.get(id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    if (!guard(req, reply, auth, principalOf(req), existing.scope ?? '', 'admin')) return;
    return { ok: dox.docs.remove(id) };
  });

  // ---- Sessions ----
  app.get('/sessions', async (req, reply) => {
    const q = req.query as { scope?: string; limit?: string };
    if (q.scope && !guard(req, reply, auth, principalOf(req), q.scope, 'read')) return;
    return dox.sessions.list(q.scope, q.limit ? parseInt(q.limit, 10) : undefined);
  });

  app.post<{ Body: { scope: string; title?: string } }>('/sessions', async (req, reply) => {
    if (!req.body?.scope) return reply.code(400).send({ error: 'scope_required' });
    if (!guard(req, reply, auth, principalOf(req), req.body.scope, 'write')) return;
    return dox.sessions.create({ scope: req.body.scope, title: req.body.title });
  });

  app.get('/sessions/:id', async (req, reply) => {
    const s = dox.sessions.get((req.params as { id: string }).id);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    if (!guard(req, reply, auth, principalOf(req), s.scope, 'read')) return;
    return s;
  });

  app.post<{ Params: { id: string }; Body: { role: string; content: string; refs?: string[] } }>(
    '/sessions/:id/messages',
    async (req, reply) => {
      const s = dox.sessions.get(req.params.id);
      if (!s) return reply.code(404).send({ error: 'session_not_found' });
      if (!guard(req, reply, auth, principalOf(req), s.scope, 'write')) return;
      const { role, content, refs } = req.body;
      if (!role || !content) return reply.code(400).send({ error: 'role_content_required' });
      const msg = dox.sessions.append(req.params.id, { role: role as never, content, refs });
      if (!msg) return reply.code(404).send({ error: 'session_not_found' });
      return msg;
    },
  );

  app.post('/sessions/:id/end', async (req, reply) => {
    const s = dox.sessions.get((req.params as { id: string }).id);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    if (!guard(req, reply, auth, principalOf(req), s.scope, 'write')) return;
    return dox.sessions.end(s.id);
  });

  app.delete('/sessions/:id', async (req, reply) => {
    const s = dox.sessions.get((req.params as { id: string }).id);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    if (!guard(req, reply, auth, principalOf(req), s.scope, 'admin')) return;
    dox.sessions.remove(s.id);
    return { ok: true, removed: s.id };
  });

  // ---- Context ----
  app.post<{ Body: ContextRequest }>('/context/assemble', async (req, reply) => {
    const scope = req.body?.scope;
    if (!scope) return reply.code(400).send({ error: 'scope_required' });
    if (!guard(req, reply, auth, principalOf(req), scope, 'read')) return;
    return dox.context.assemble({ ...req.body, scope });
  });

  // Latest auto-refreshed context baseline for a scope.
  app.get('/context/snapshot', async (req, reply) => {
    const scope = (req.query as { scope?: string }).scope ?? '';
    if (scope && !guard(req, reply, auth, principalOf(req), scope, 'read')) return;
    const snap = dox.context.getSnapshot(scope);
    if (!snap) return reply.code(404).send({ error: 'no_snapshot' });
    return snap;
  });

  // Force-refresh + persist the context baseline now.
  app.post<{ Body: { scope?: string } }>('/context/refresh', async (req, reply) => {
    const scope = req.body?.scope;
    if (!scope) return reply.code(400).send({ error: 'scope_required' });
    if (!guard(req, reply, auth, principalOf(req), scope, 'write')) return;
    return dox.context.saveSnapshot(scope);
  });

  // ---- Historic project context ("the brief") ----
  app.get('/context/brief', async (req, reply) => {
    const scope = (req.query as { scope?: string }).scope ?? '';
    if (scope && !guard(req, reply, auth, principalOf(req), scope, 'read')) return;
    const brief = dox.context.getBrief(scope);
    if (!brief) return reply.code(404).send({ error: 'no_brief' });
    return brief;
  });

  app.put<{ Body: { scope?: string; overview?: string; repoLayout?: string; codeStyle?: string; buildTest?: string; assetConventions?: string; gotchas?: string } }>('/context/brief', async (req, reply) => {
    const scope = req.body?.scope;
    if (!scope) return reply.code(400).send({ error: 'scope_required' });
    if (!guard(req, reply, auth, principalOf(req), scope, 'write')) return;
    return dox.context.saveBrief(scope, req.body ?? {});
  });

  app.post<{ Body: { scope?: string; title?: string; decision?: string; rationale?: string } }>('/context/brief/decision', async (req, reply) => {
    const { scope, title, decision, rationale } = req.body ?? {};
    if (!scope || !title || !decision) return reply.code(400).send({ error: 'scope_title_decision_required' });
    if (!guard(req, reply, auth, principalOf(req), scope, 'write')) return;
    return dox.context.addDecision(scope, { title, decision, rationale });
  });

  app.post<{ Body: { scope?: string } }>('/context/brief/seed', async (req, reply) => {
    const scope = req.body?.scope;
    if (!scope) return reply.code(400).send({ error: 'scope_required' });
    if (!guard(req, reply, auth, principalOf(req), scope, 'write')) return;
    return dox.context.seedBrief(scope);
  });

  // ---- MCP over HTTP (streamable transport, one authenticated session per bearer token) ----
  const mcpSessions = new Map<string, { transport: StreamableHTTPServerTransport; close: () => void }>();
  const mcpErr = (res: ServerResponse, status: number, message: string) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
  };

  app.all('/mcp', async (request, reply) => {
    const sessionId = request.headers['mcp-session-id'] as string | undefined;
    reply.hijack(); // we own the raw node response from here

    if (request.method === 'DELETE') {
      if (sessionId) {
        const s = mcpSessions.get(sessionId);
        if (s) { s.close(); mcpSessions.delete(sessionId); }
      }
      reply.raw.statusCode = 204;
      reply.raw.end();
      return;
    }

    if (request.method === 'GET') { // SSE stream for an existing session
      const s = sessionId ? mcpSessions.get(sessionId) : undefined;
      if (!s) { mcpErr(reply.raw, 404, 'unknown session'); return; }
      await s.transport.handleRequest(request.raw, reply.raw);
      return;
    }

    if (request.method !== 'POST') { reply.raw.statusCode = 405; reply.raw.end(); return; }
    // parsedBody must be the ALREADY-PARSED object (the transport JSON-parses it again).
    const parsedBody = request.body;

    if (sessionId) { // continue an existing session
      const s = mcpSessions.get(sessionId);
      if (!s) { mcpErr(reply.raw, 404, 'unknown session'); return; }
      await s.transport.handleRequest(request.raw, reply.raw, parsedBody);
      return;
    }

    // New session: resolve the caller's principal (bearer) — reject if auth is on and unauthenticated.
    const p = principalOf(request);
    if (auth.enabled && !p) { mcpErr(reply.raw, 401, 'unauthorized: send a valid bearer token'); return; }

    const id = randomUUID();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => id });
    try {
      const mcp = createMcpServer(dox, p);
      await mcp.connect(transport);
      mcpSessions.set(id, { transport, close: () => void transport.close().catch(() => undefined) });
      await transport.handleRequest(request.raw, reply.raw, parsedBody);
    } catch (e) {
      void transport.close().catch(() => undefined);
      mcpErr(reply.raw, 500, (e as Error).message);
    }
  });

  return { app, dox, auth };
}

/**
 * Auto-context-update job: periodically reassemble + persist each active scope's context
 * baseline. Controlled by AGENTDOX_CONTEXT_AUTOUPDATE / AGENTDOX_CONTEXT_INTERVAL_SECONDS
 * / AGENTDOX_CONTEXT_MAX_SCOPES (default 900s=15min, 50 scopes). Returns null when disabled.
 */
const EMBED_BATCH_PER_TICK = 256;

function startContextScheduler(dox: AgentDox): { intervalSeconds: number; stop: () => void } | null {
  const seconds = parseInt(process.env.AGENTDOX_CONTEXT_INTERVAL_SECONDS ?? '900', 10);
  const maxScopes = parseInt(process.env.AGENTDOX_CONTEXT_MAX_SCOPES ?? '50', 10);
  if (!(seconds > 0)) return null; // 0 / negative disables

  const runOnce = async () => {
    try {
      const scopes = dox.context.targetScopes().slice(0, maxScopes);
      let refreshed = 0;
      for (const scope of scopes) {
        try {
          await dox.context.saveSnapshot(scope);
          refreshed++;
        } catch (e) {
          console.error(`[ctxjob] ${scope}: ${(e as Error).message}`);
        }
      }
      if (refreshed > 0) console.log(`[ctxjob] refreshed ${refreshed}/${scopes.length} scope(s)`);
      // Vectors are deliberately off the write path, so this tick is where they catch up.
      // A provider that is down reports an error and the next tick simply retries.
      if (dox.index.embeddingProvider) {
        const r = await dox.index.backfillEmbeddings({ limit: EMBED_BATCH_PER_TICK });
        if (r.embedded) console.log(`[ctxjob] embedded ${r.embedded}, ${r.pending} pending`);
        else if (r.error) console.error(`[ctxjob] embedding backfill: ${r.error}`);
      }
    } catch (e) {
      console.error('[ctxjob] tick failed', (e as Error).message);
    }
  };

  void runOnce(); // refresh immediately on boot, then on the interval
  const timer = setInterval(() => void runOnce(), seconds * 1000);
  timer.unref?.();
  return { intervalSeconds: seconds, stop: () => clearInterval(timer) };
}

export async function startServer(opts: BuildOptions & { port?: number } = {}): Promise<{ app: FastifyInstance; dox: AgentDox; auth: AuthContext; port: number; stopScheduler: () => void }> {
  const { app, dox, auth } = buildApp(opts);
  const port = opts.port ?? 3003;
  // Wait for async OIDC discovery to finish before listening.
  await new Promise<void>((resolve_) => {
    if (!auth.enabled) return resolve_();
    const check = () => (auth.chain ? resolve_() : setTimeout(check, 25));
    check();
  });
  await app.listen({ port, host: '0.0.0.0' });
  // Report the actual bound port (matters when port === 0 / ephemeral).
  const actualPort = (app.server.address() as import('node:net').AddressInfo).port;
  // Start the periodic auto-context job.
  const sched = startContextScheduler(dox);
  console.log(`[agentdox] auto-context job: ${sched ? `every ${sched.intervalSeconds}s` : 'disabled'}`);
  return { app, dox, auth, port: actualPort, stopScheduler: sched ? sched.stop : () => undefined };
}

// Direct execution
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3003;
  const { app, dox, port: p, stopScheduler } = await startServer({ port });
  const shutdown = () => {
    stopScheduler();
    app.close().then(() => {
      dox.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  console.log(`[agentdox] API listening on http://localhost:${p} (auth ${dox ? 'configured' : ''})`);
}

/** Small internal helpers for scope-filtering list responses. */

/** Ensure a principal exists (caller already passed guard() when auth is enabled). */
function validatePrincipal(p: Principal | null): Principal {
  if (!p) throw new Error('principal missing despite auth guard');
  return p;
}

/** Does the principal hold at least `role` on `scope` (or a wildcard grant)? */
function scopeGrant(principal: Principal, scope: string, role: Role): boolean {
  const grant = principal.grants[scope] ?? principal.grants['*'] ?? 'none';
  return roleAtLeast(grant, role);
}
