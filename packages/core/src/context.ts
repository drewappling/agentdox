import type { ContextRequest, ContextSlice, Doc, DocPassage, MemoryHit } from '@agentdox/types';
import { DocService } from './docs.js';
import { MemoryService } from './memory.js';
import { SessionService } from './sessions.js';
import type { Store } from './db.js';
import { newId, nowIso } from './util.js';

const DEFAULT_MEMORY_LIMIT = 15;
const DEFAULT_DOCS_LIMIT = 3;
const DEFAULT_SESSION_LIMIT = 20;
const DEFAULT_MIN_IMPORTANCE = 0.7;
/** Whole-doc fallback trim, used only when there is no query to retrieve passages with. */
const MAX_DOC_CHARS = 2000;
/**
 * The brief is query-independent and the most curated content in the store, so
 * it is worth prompt-cache space — but it grows by one entry per recorded
 * decision and must never crowd out the query-relevant material. Measured on two
 * live scopes (2026-08-29): the static sections total ~1.6k chars while the
 * decision log is 19,124 of 20,734 (92%). So the static sections are always
 * kept and the log takes whatever budget remains, newest first.
 */
const BRIEF_STATIC_KEYS = ['overview', 'repoLayout', 'codeStyle', 'buildTest', 'assetConventions', 'gotchas'] as const;
const BRIEF_SECTION_LABEL: Record<(typeof BRIEF_STATIC_KEYS)[number], string> = {
  overview: 'Overview',
  repoLayout: 'Repo layout & tooling',
  codeStyle: 'Code style',
  buildTest: 'Build & test',
  assetConventions: 'Asset conventions',
  gotchas: 'Gotchas',
};

/** A persisted, auto-refreshed context baseline for one scope/project. */
export interface ContextSnapshot {
  scope: string;
  query: string;
  prompt: string;
  chars: number;
  memoryHits: number;
  docs: number;
  sessionMsgs: number;
  assembledAt: string;
}

/** One entry in the project's historic decision/convention log. */
export interface DecisionEntry {
  id: string;
  title: string;
  decision: string;
  rationale: string;
  at: string;
}

/** The durable, cumulative on-ramp ("historic context") for a project/scope. */
export interface ProjectBrief {
  scope: string;
  overview: string;
  repoLayout: string;
  codeStyle: string;
  buildTest: string;
  assetConventions: string;
  gotchas: string;
  decisionLog: DecisionEntry[];
  updatedAt: string;
}

export interface ContextAssemblerDeps {
  memory: MemoryService;
  docs: DocService;
  sessions: SessionService;
  store: Store;
}

export class ContextService {
  constructor(private readonly deps: ContextAssemblerDeps) {}

  async assemble(request: ContextRequest): Promise<ContextSlice> {
    const memoryLimit = request.memoryLimit ?? DEFAULT_MEMORY_LIMIT;
    const docsLimit = request.docsLimit ?? DEFAULT_DOCS_LIMIT;
    const sessionLimit = request.sessionLimit ?? DEFAULT_SESSION_LIMIT;
    const minImportance = request.minImportance ?? DEFAULT_MIN_IMPORTANCE;
    const query = request.query?.trim() ?? '';
    const scope = request.scope;

    // --- Memory: relevance + importance, topped up with high-importance entries. ---
    let memory: MemoryHit[];
    if (query) {
      const hits = await this.deps.memory.search(query, {
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

    // --- Docs: passages when there is a query, whole docs when there is not. ---
    // A query lets retrieval pick the passage that matched; with no query there is nothing to
    // rank by, so the most-recent whole docs (trimmed) remain the best available baseline.
    let passages: DocPassage[] = [];
    let docs: Doc[] = [];
    if (query) {
      passages = await this.deps.docs.searchChunks(query, { scope, limit: docsLimit });
      const seenDocs = new Set<string>();
      for (const p of passages) {
        if (seenDocs.has(p.docId)) continue;
        seenDocs.add(p.docId);
        const doc = this.deps.docs.get(p.docId);
        if (doc) docs.push(doc);
      }
    }
    if (!passages.length) docs = this.deps.docs.list({ scope, limit: docsLimit });

    // --- Sessions: most recent messages in scope. ---
    const sessionMessages = this.deps.sessions.recentMessages(scope, sessionLimit);

    // --- Brief: query-independent, so it renders FIRST and caches well. ---
    const briefBudget = request.briefChars ?? 0;
    const briefBlock = briefBudget > 0 ? this.renderBrief(scope, briefBudget) : '';

    const prompt = this.render({ request, memory, docs, passages, sessionMessages, briefBlock });
    return {
      request,
      assembledAt: new Date().toISOString(),
      memory,
      docs,
      passages,
      sessionMessages,
      prompt,
      chars: prompt.length,
      briefChars: briefBlock.length,
    };
  }

  /** Assemble + persist a context baseline for a scope (auto-context-update job). */
  async saveSnapshot(scope: string, query = ''): Promise<ContextSnapshot> {
    const s = await this.assemble({ scope, query });
    const snap: ContextSnapshot = {
      scope,
      query,
      prompt: s.prompt,
      chars: s.chars,
      memoryHits: s.memory.length,
      docs: s.docs.length,
      sessionMsgs: s.sessionMessages.length,
      assembledAt: new Date().toISOString(),
    };
    this.deps.store.db
      .prepare(
        `INSERT INTO context_snapshots (id, scope, query, prompt, chars, memory_hits, docs_count, session_msgs, assembled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope) DO UPDATE SET
           query=excluded.query, prompt=excluded.prompt, chars=excluded.chars,
           memory_hits=excluded.memory_hits, docs_count=excluded.docs_count,
           session_msgs=excluded.session_msgs, assembled_at=excluded.assembled_at`,
      )
      .run(newId('snap'), scope, query, snap.prompt, snap.chars, snap.memoryHits, snap.docs, snap.sessionMsgs, snap.assembledAt);
    return snap;
  }

  /** Read the latest persisted context snapshot for a scope, or null. */
  getSnapshot(scope: string): ContextSnapshot | null {
    const r = this.deps.store.db
      .prepare('SELECT scope, query, prompt, chars, memory_hits, docs_count, session_msgs, assembled_at FROM context_snapshots WHERE scope = ?')
      .get(scope) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      scope: r.scope as string,
      query: r.query as string,
      prompt: r.prompt as string,
      chars: r.chars as number,
      memoryHits: r.memory_hits as number,
      docs: r.docs_count as number,
      sessionMsgs: r.session_msgs as number,
      assembledAt: r.assembled_at as string,
    };
  }

  /** Distinct scopes that hold any context-bearing data or a project row (scheduler targets). */
  targetScopes(): string[] {
    const rows = this.deps.store.db
      .prepare(
        `SELECT scope FROM (
           SELECT DISTINCT category AS scope FROM memory
           UNION SELECT DISTINCT scope FROM docs
           UNION SELECT DISTINCT scope FROM sessions
           UNION SELECT DISTINCT slug AS scope FROM projects
         ) WHERE scope IS NOT NULL AND scope != ''`,
      )
      .all() as { scope: string }[];
    return rows.map((r) => r.scope);
  }

  // ---------------------------------------------------------------------------
  // Historic project context ("the brief") — the durable on-ramp an agent reads
  // when first starting on a project: decisions, repo/code conventions, gotchas.
  // ---------------------------------------------------------------------------

  emptyBrief(scope: string): ProjectBrief {
    return {
      scope,
      overview: '',
      repoLayout: '',
      codeStyle: '',
      buildTest: '',
      assetConventions: '',
      gotchas: '',
      decisionLog: [],
      updatedAt: new Date().toISOString(),
    };
  }

  getBrief(scope: string): ProjectBrief | null {
    const r = this.deps.store.db.prepare('SELECT brief_json FROM context_briefs WHERE scope = ?').get(scope) as { brief_json: string } | undefined;
    if (!r) return null;
    try {
      const b = JSON.parse(r.brief_json) as ProjectBrief;
      if (!Array.isArray(b.decisionLog)) b.decisionLog = [];
      return b;
    } catch {
      return this.emptyBrief(scope);
    }
  }

  /** Write the full brief (sections are replaced; the decision log is preserved unless provided). */
  saveBrief(scope: string, partial: Partial<ProjectBrief>): ProjectBrief {
    const prev = this.getBrief(scope) ?? this.emptyBrief(scope);
    const brief: ProjectBrief = {
      scope,
      overview: partial.overview ?? prev.overview,
      repoLayout: partial.repoLayout ?? prev.repoLayout,
      codeStyle: partial.codeStyle ?? prev.codeStyle,
      buildTest: partial.buildTest ?? prev.buildTest,
      assetConventions: partial.assetConventions ?? prev.assetConventions,
      gotchas: partial.gotchas ?? prev.gotchas,
      decisionLog: Array.isArray(partial.decisionLog) ? partial.decisionLog : prev.decisionLog,
      updatedAt: new Date().toISOString(),
    };
    this.persistBrief(brief);
    return brief;
  }

  /** Append a decision/convention to the brief's historic log. */
  addDecision(scope: string, input: { title: string; decision: string; rationale?: string }): ProjectBrief {
    const prev = this.getBrief(scope) ?? this.emptyBrief(scope);
    prev.decisionLog = prev.decisionLog ?? [];
    prev.decisionLog.push({
      id: newId('dec'),
      title: input.title,
      decision: input.decision,
      rationale: input.rationale ?? '',
      at: new Date().toISOString(),
    });
    prev.updatedAt = nowIso();
    this.persistBrief(prev);
    return prev;
  }

  /** Build a starter brief from the project's current top memory + docs (used for first-time seeding). */
  seedBrief(scope: string): ProjectBrief {
    const prev = this.getBrief(scope) ?? this.emptyBrief(scope);
    const topMem = this.deps.memory.list({ category: scope, limit: 12 });
    const topDocs = this.deps.docs.list({ scope, limit: 8 });
    const brief: ProjectBrief = {
      ...prev,
      scope,
      overview: prev.overview || (topDocs[0]?.title ?? ''),
      codeStyle: prev.codeStyle,
      repoLayout: prev.repoLayout,
      buildTest: prev.buildTest,
      assetConventions: prev.assetConventions,
      gotchas: prev.gotchas,
      updatedAt: nowIso(),
    };
    // Seed a "known facts / conventions" baseline from memory when empty.
    if (!prev.codeStyle && topMem.length) {
      brief.codeStyle = topMem.slice(0, 6).map((m) => `- ${m.content}`).join('\n');
    }
    this.persistBrief(brief);
    return brief;
  }

  private persistBrief(brief: ProjectBrief): void {
    this.deps.store.db
      .prepare('INSERT INTO context_briefs (scope, brief_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(scope) DO UPDATE SET brief_json=excluded.brief_json, updated_at=excluded.updated_at')
      .run(brief.scope, JSON.stringify(brief), brief.updatedAt);
  }

  /**
   * Render the project brief within `budgetChars`. Layout is byte-exact against
   * the budget: static sections first (measured ~1.6k chars, they carry the
   * durable conventions), then as many decision-log entries as fit, NEWEST
   * first — the newest decision is the one still in force, and older ones
   * survive in `GET /context/brief` for anyone who needs the history.
   *
   * An entry that does not fit whole is dropped, never truncated mid-sentence:
   * a half-decision is worse than an absent one, and the next entry down may
   * fit. Empty scopes render nothing rather than a hollow scaffold.
   */
  private renderBrief(scope: string, budgetChars: number): string {
    const brief = this.getBrief(scope);
    if (brief === null) return '';

    const section = (label: string, body: string): string => (body.trim() ? `## ${label}\n${body.trim()}\n` : '');
    const parts: string[] = [`# Project brief: ${scope} (updated ${brief.updatedAt})\n`];

    for (const key of BRIEF_STATIC_KEYS) {
      const block = section(BRIEF_SECTION_LABEL[key], brief[key] ?? '');
      if (!block) continue;
      if (parts.join('').length + block.length > budgetChars) break;
      parts.push(block);
    }

    const used = parts.join('').length;
    let logBudget = budgetChars - used;
    const logLines: string[] = [];
    for (const d of [...brief.decisionLog].sort((a, b) => (a.at < b.at ? 1 : -1))) {
      if (logBudget <= 0) break;
      const line = `- ${d.title}: ${d.decision}`;
      if (line.length > logBudget) break;
      logLines.push(line);
      logBudget -= line.length + 1;
    }
    if (logLines.length > 0) {
      parts.push(`## Decisions (newest first)\n${logLines.join('\n')}\n`);
    }

    const out = parts.join('\n').trimEnd();
    return out.length <= budgetChars ? out : out.slice(0, budgetChars);
  }

  private render(ctx: {
    request: ContextRequest;
    memory: MemoryHit[];
    docs: { id: string; slug: string; title: string; content: string; version: number }[];
    passages: DocPassage[];
    sessionMessages: { role: string; content: string }[];
    /** Pre-rendered budgeted brief, or '' when not requested. Rendered first. */
    briefBlock: string;
  }): string {
    const scope = ctx.request.scope;
    const lines: string[] = [];
    lines.push(`# Context: ${scope}`);
    if (ctx.request.query) lines.push(`Task/relevance query: ${ctx.request.query}`);
    lines.push('');

    if (ctx.briefBlock) {
      lines.push(ctx.briefBlock);
      lines.push('');
    }

    lines.push('## Memory');
    if (ctx.memory.length === 0) lines.push('(no stored memory in this scope)');
    for (const { entry, score } of ctx.memory) {
      const tag = entry.category || entry.target ? ` [${entry.category || ''}${entry.target ? '/' + entry.target : ''}]` : '';
      lines.push(`- (${score.toFixed(2)})${tag} ${entry.content}`);
    }
    lines.push('');

    lines.push('## Docs');
    if (ctx.passages.length) {
      // Passages carry slug + heading, so an agent that needs more can open the full doc.
      for (const p of ctx.passages) {
        lines.push(`### ${p.title} — ${p.heading ? `${p.slug} § ${p.heading}` : p.slug}`);
        lines.push(p.content);
        lines.push('');
      }
    } else if (ctx.docs.length === 0) {
      lines.push('(no docs in this scope)');
    } else {
      for (const doc of ctx.docs) {
        lines.push(`### ${doc.title} (v${doc.version}) — ${doc.slug}`);
        const body = doc.content.length > MAX_DOC_CHARS ? doc.content.slice(0, MAX_DOC_CHARS) + '\n…(truncated)' : doc.content;
        lines.push(body);
        lines.push('');
      }
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
