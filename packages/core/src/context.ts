import type { ContextRequest, ContextSlice, MemoryHit } from '@agentdox/types';
import { DocService } from './docs.js';
import { MemoryService } from './memory.js';
import { SessionService } from './sessions.js';

const DEFAULT_MEMORY_LIMIT = 15;
const DEFAULT_DOCS_LIMIT = 3;
const DEFAULT_SESSION_LIMIT = 20;
const DEFAULT_MIN_IMPORTANCE = 0.7;
/** Long docs are trimmed so they don't blow the context budget. */
const MAX_DOC_CHARS = 2000;

export interface ContextAssemblerDeps {
  memory: MemoryService;
  docs: DocService;
  sessions: SessionService;
}

export class ContextService {
  constructor(private readonly deps: ContextAssemblerDeps) {}

  assemble(request: ContextRequest): ContextSlice {
    const memoryLimit = request.memoryLimit ?? DEFAULT_MEMORY_LIMIT;
    const docsLimit = request.docsLimit ?? DEFAULT_DOCS_LIMIT;
    const sessionLimit = request.sessionLimit ?? DEFAULT_SESSION_LIMIT;
    const minImportance = request.minImportance ?? DEFAULT_MIN_IMPORTANCE;
    const query = request.query?.trim() ?? '';
    const scope = request.scope;

    // --- Memory: relevance + importance, topped up with high-importance entries. ---
    let memory: MemoryHit[];
    if (query) {
      const hits = this.deps.memory.search(query, {
        category: scope,
        importanceBoost: 3,
        limit: memoryLimit,
      });
      if (hits.length < memoryLimit) {
        const seen = new Set(hits.map((h) => h.entry.id));
        for (const entry of this.deps.memory.list({ category: scope, limit: memoryLimit * 3 })) {
          if (seen.has(entry.id)) continue;
          if (entry.importance >= minImportance) {
            hits.push({ entry, score: entry.importance });
            seen.add(entry.id);
            if (hits.length >= memoryLimit) break;
          }
        }
      }
      memory = hits;
    } else {
      memory = this.deps.memory
        .list({ category: scope, limit: memoryLimit })
        .map((entry) => ({ entry, score: entry.importance }));
    }
    memory = memory.slice(0, memoryLimit);

    // --- Docs: query-relevant, else most-recent in scope. ---
    let docs = query
      ? this.deps.docs.search(query, { scope, limit: docsLimit })
      : this.deps.docs.list({ scope, limit: docsLimit });
    if (docs.length < docsLimit) {
      const seen = new Set(docs.map((d) => d.id));
      for (const doc of this.deps.docs.list({ scope, limit: docsLimit * 5 })) {
        if (seen.has(doc.id)) continue;
        docs.push(doc);
        seen.add(doc.id);
        if (docs.length >= docsLimit) break;
      }
    }
    docs = docs.slice(0, docsLimit);

    // --- Sessions: most recent messages in scope. ---
    const sessionMessages = this.deps.sessions.recentMessages(scope, sessionLimit);

    const prompt = this.render({ request, memory, docs, sessionMessages });
    return {
      request,
      assembledAt: new Date().toISOString(),
      memory,
      docs,
      sessionMessages,
      prompt,
      chars: prompt.length,
    };
  }

  private render(ctx: {
    request: ContextRequest;
    memory: MemoryHit[];
    docs: { id: string; slug: string; title: string; content: string; version: number }[];
    sessionMessages: { role: string; content: string }[];
  }): string {
    const scope = ctx.request.scope;
    const lines: string[] = [];
    lines.push(`# Context: ${scope}`);
    if (ctx.request.query) lines.push(`Task/relevance query: ${ctx.request.query}`);
    lines.push('');

    lines.push('## Memory');
    if (ctx.memory.length === 0) lines.push('(no stored memory in this scope)');
    for (const { entry, score } of ctx.memory) {
      const tag = entry.category || entry.target ? ` [${entry.category || ''}${entry.target ? '/' + entry.target : ''}]` : '';
      lines.push(`- (${score.toFixed(2)})${tag} ${entry.content}`);
    }
    lines.push('');

    lines.push('## Docs');
    if (ctx.docs.length === 0) lines.push('(no docs in this scope)');
    for (const doc of ctx.docs) {
      lines.push(`### ${doc.title} (v${doc.version}) — ${doc.slug}`);
      const body = doc.content.length > MAX_DOC_CHARS ? doc.content.slice(0, MAX_DOC_CHARS) + '\n…(truncated)' : doc.content;
      lines.push(body);
      lines.push('');
    }

    lines.push('## Recent conversation');
    if (ctx.sessionMessages.length === 0) lines.push('(no recent session activity)');
    for (const m of ctx.sessionMessages) {
      const content = m.content.length > 400 ? m.content.slice(0, 400) + '…' : m.content;
      lines.push(`${m.role === 'assistant' ? 'assistant:' : m.role === 'user' ? 'user:' : m.role}: ${content}`);
    }

    return lines.join('\n');
  }
}
