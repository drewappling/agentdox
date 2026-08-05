import type {
  ContextRequest,
  ContextSlice,
  Doc,
  DocVersion,
  MemoryEntry,
  MemoryHit,
  Project,
  ProjectProvision,
  Session,
  SessionMessage,
} from '@agentdox/types';

export interface MemoryFilter {
  category?: string;
  target?: string;
  tag?: string;
  limit?: number;
}

/** Thin typed client for the agentdox REST API. Works in Node and browser. */
export class AgentDoxClient {
  constructor(
    readonly baseUrl: string = 'http://localhost:3003',
    private readonly fetchImpl: typeof fetch = fetch,
    /** Optional bearer token (OIDC access token or PAT). Sent as `Authorization: Bearer …`. */
    private readonly authToken?: string,
  ) {}

  /** Return a copy of the client bound to a different bearer token. */
  withToken(authToken: string): AgentDoxClient {
    return new AgentDoxClient(this.baseUrl, this.fetchImpl, authToken);
  }

  private async request<T>(method: string, path: string, body?: unknown, query?: Record<string, string | undefined>): Promise<T> {
    const qs = query
      ? '?' + Object.entries(query)
          .filter(([, v]) => v !== undefined && v !== '')
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`)
          .join('&')
      : '';
    const headers: Record<string, string> = {};
    if (this.authToken) headers['Authorization'] = `Bearer ${this.authToken}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    // Invoke fetch as an unbound local so native fetch keeps `window`/globalThis as `this`
    // (Chrome/Safari reject fetch called with an arbitrary receiver).
    const f: typeof fetch = this.fetchImpl;
    const res = await f(`${this.baseUrl}${path}${qs}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`agentdox API ${method} ${path} failed (${res.status}): ${text}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async health(): Promise<{ ok: boolean; service: string }> {
    return this.request('GET', '/health');
  }

  // ---- Memory ----
  memory = {
    list: (filter: MemoryFilter = {}) =>
      this.request<MemoryEntry[]>('GET', '/memory', undefined, {
        category: filter.category,
        target: filter.target,
        tag: filter.tag,
        limit: filter.limit?.toString(),
      }),
    search: (q: string, filter: MemoryFilter = {}) =>
      this.request<MemoryHit[]>('GET', '/memory/search', undefined, {
        q,
        category: filter.category,
        target: filter.target,
        tag: filter.tag,
        limit: filter.limit?.toString(),
      }),
    get: (id: string) => this.request<MemoryEntry>('GET', `/memory/${id}`),
    create: (input: { content: string; category?: string; target?: string; importance?: number; tags?: string[]; source?: string }) =>
      this.request<MemoryEntry>('POST', '/memory', input),
    update: (id: string, patch: Partial<Omit<MemoryEntry, 'id' | 'createdAt'>>) =>
      this.request<MemoryEntry>('PATCH', `/memory/${id}`, patch),
    remove: (id: string) => this.request<{ ok: boolean }>('DELETE', `/memory/${id}`),
  };

  // ---- Docs ----
  docs = {
    list: (filter: { scope?: string; tag?: string; limit?: number } = {}) =>
      this.request<Doc[]>('GET', '/docs', undefined, {
        scope: filter.scope,
        tag: filter.tag,
        limit: filter.limit?.toString(),
      }),
    search: (q: string, filter: { scope?: string; limit?: number } = {}) =>
      this.request<Doc[]>('GET', '/docs/search', undefined, { q, scope: filter.scope, limit: filter.limit?.toString() }),
    get: (id: string) => this.request<Doc>('GET', `/docs/${id}`),
    getBySlug: (slug: string) => this.request<Doc>('GET', `/docs/slug/${encodeURIComponent(slug)}`),
    create: (input: { slug: string; title: string; content: string; tags?: string[]; scope?: string }) =>
      this.request<Doc>('POST', '/docs', input),
    update: (id: string, patch: Partial<Pick<Doc, 'title' | 'content' | 'tags' | 'scope' | 'slug'>>) =>
      this.request<Doc>('PATCH', `/docs/${id}`, patch),
    remove: (id: string) => this.request<{ ok: boolean }>('DELETE', `/docs/${id}`),
    history: (id: string) => this.request<DocVersion[]>('GET', `/docs/${id}/history`),
  };

  // ---- Sessions ----
  sessions = {
    list: (scope?: string, limit?: number) =>
      this.request<Session[]>('GET', '/sessions', undefined, { scope, limit: limit?.toString() }),
    create: (input: { scope: string; title?: string }) => this.request<Session>('POST', '/sessions', input),
    get: (id: string) => this.request<Session>('GET', `/sessions/${id}`),
    append: (id: string, msg: { role: SessionMessage['role']; content: string; refs?: string[] }) =>
      this.request<SessionMessage>('POST', `/sessions/${id}/messages`, msg),
    end: (id: string) => this.request<Session>('POST', `/sessions/${id}/end`),
  };

  // ---- Context ----
  context = {
    assemble: (req: ContextRequest) => this.request<ContextSlice>('POST', '/context/assemble', req),
  };

  // ---- Projects (agent-provisioned workspaces) ----
  projects = {
    list: () => this.request<Project[]>('GET', '/projects'),
    get: (slug: string) => this.request<Project>('GET', `/projects/${encodeURIComponent(slug)}`),
    /** Create/ensure a project workspace by slug. Hands back a scoped PAT on first claim. */
    ensure: (input: { slug: string; name: string; description?: string }) =>
      this.request<ProjectProvision>('POST', '/projects', input),
    /** Delete a project and all of its scoped data (admin or owner). */
    remove: (slug: string) => this.request<{ ok: boolean; removed: string }>('DELETE', `/projects/${encodeURIComponent(slug)}`),
  };
}
