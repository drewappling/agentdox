import type { ContextLayers, ContextRequest, ContextSlice, Doc, DocPassage, MemoryEntry, MemoryHit } from '@agentdox/types';
import { DocService } from './docs.js';
import { MemoryService } from './memory.js';
import { SessionService } from './sessions.js';
import type { Store } from './db.js';
import { newId, nowIso } from './util.js';

const DEFAULT_MEMORY_LIMIT = 15;
const DEFAULT_DOCS_LIMIT = 3;
const DEFAULT_SESSION_LIMIT = 20;
const DEFAULT_MIN_IMPORTANCE = 0.7;
/**
 * Layered context (project memory, phase one). The group layer is the most stable — true across
 * every project the group works on — so it leads and gets a brief-sized budget; the personal
 * layer is one member's own thread and trails, led by the handoff note. Neither is rendered
 * unless asked for, so a single-scope request is unchanged.
 */
const DEFAULT_GROUP_CHARS = 4000;
const DEFAULT_GROUP_MEMORY_LIMIT = 4;
const DEFAULT_PERSONAL_LIMIT = 6;
/** The tag that marks a personal scope's handoff note: what was done, what is open, what next. */
const HANDOFF_TAG = 'handoff';
/**
 * Share of the session budget reserved for the most recent messages. The rest goes to
 * relevance-ranked older ones. Two thirds keeps a resumable conversation tail intact while
 * still leaving room to reach back for the turn that actually answers the query.
 */
const RECENCY_SHARE = 2 / 3;
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

/** One memory entry as a list line; the layer sections need no scope tag since the heading names it. */
const memoryLine = (e: MemoryEntry): string => `- (${e.importance.toFixed(2)}) ${e.content}`;

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
        for (const entry of await this.deps.memory.list({ category: scope, limit: memoryLimit * 3 })) {
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
      memory = (await this.deps.memory.list({ category: scope, limit: memoryLimit })).map((entry) => ({ entry, score: entry.importance }));
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
        const doc = await this.deps.docs.get(p.docId);
        if (doc) docs.push(doc);
      }
    }
    if (!passages.length) docs = await this.deps.docs.list({ scope, limit: docsLimit });

    // --- Sessions: recency for continuity, relevance for recall. ---
    // Pure recency (the original behaviour) meant anything discussed more than `sessionLimit`
    // messages ago could not reach the block however directly it answered the query. Pure
    // relevance would break continuity — an agent resuming work needs the last few turns
    // whether or not they match. So the budget is split: the newest RECENCY_SHARE of it is the
    // tail of the conversation, and the remainder is filled with relevant older messages.
    const recentCount = query ? Math.max(1, Math.ceil(sessionLimit * RECENCY_SHARE)) : sessionLimit;
    // With `user`, the tail is that member's own turns in the shared project; the relevance
    // arm below stays unfiltered, since a colleague's answer is still the answer.
    const recent = await this.deps.sessions.recentMessages(scope, recentCount, request.user);
    let sessionMessages = recent;
    if (query && sessionLimit > recentCount) {
      const exclude = new Set(recent.map((m) => m.id).filter((id): id is number => id !== undefined));
      const older = await this.deps.sessions.relevantMessages(scope, query, {
        limit: sessionLimit - recentCount,
        exclude,
      });
      // Older-but-relevant first, then the recent tail: the block reads chronologically.
      sessionMessages = [...older, ...recent];
    }

    // --- Brief: query-independent, so it renders FIRST and caches well. ---
    const briefBudget = request.briefChars ?? 0;
    const briefBlock = briefBudget > 0 ? await this.renderBrief(scope, briefBudget) : '';

    const projectBlock = this.render({ request, memory, docs, passages, sessionMessages, briefBlock });

    // --- Layers: group first (most stable), the project block, the personal thread last. ---
    // Each optional layer is a self-contained section; with neither requested the prompt IS the
    // project block, byte for byte, which is what every pre-0.3 caller still gets.
    const groupBlock = request.group
      ? await this.renderGroup(request.group, request.groupChars ?? DEFAULT_GROUP_CHARS, request.groupMemoryLimit ?? DEFAULT_GROUP_MEMORY_LIMIT)
      : null;
    const personalBlock = request.personal ? await this.renderPersonal(request.personal, request.personalLimit ?? DEFAULT_PERSONAL_LIMIT) : null;
    const prompt = [groupBlock?.text, projectBlock, personalBlock?.text].filter((b): b is string => !!b).join('\n\n');
    const layers: ContextLayers = {
      group: groupBlock && request.group ? { scope: request.group, chars: groupBlock.text.length } : null,
      project: { chars: projectBlock.length },
      personal:
        personalBlock && request.personal
          ? { scope: request.personal, chars: personalBlock.text.length, handoff: personalBlock.handoff }
          : null,
    };

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
      layers,
    };
  }

  // ---------------------------------------------------------------------------
  // The group and personal layers.
  // ---------------------------------------------------------------------------

  /**
   * `# Group context: <group>`: the group scope's brief (its sections and decisions, within
   * what is left of the budget once the memory lines are counted) and its top memory entries
   * by importance. Query-independent, like the project brief, so it caches across turns.
   */
  private async renderGroup(group: string, budgetChars: number, memoryLimit: number): Promise<{ text: string }> {
    const header = `# Group context: ${group}\n`;
    const entries = memoryLimit > 0 ? await this.deps.memory.list({ category: group, limit: memoryLimit }) : [];
    const memoryBlock = entries.length ? ['## Memory', ...entries.map(memoryLine)].join('\n') : '';
    const brief = await this.getBrief(group);
    // Memory is capped by count and small; the brief takes what remains so a long decision log
    // cannot push the facts out. The blank line joining the two is counted too.
    const briefBudget = budgetChars - (memoryBlock ? memoryBlock.length + 2 : 0);
    const briefText = brief && briefBudget > header.length ? this.renderBriefParts(header, brief, briefBudget) : header.trimEnd();
    const parts = [briefText, memoryBlock].filter(Boolean);
    const text = !brief && !memoryBlock ? `${header}(nothing recorded for this group yet)` : parts.join('\n\n');
    return { text: text.length <= budgetChars ? text : text.slice(0, budgetChars) };
  }

  /**
   * `# Your thread in <scope>`: one member's own thread in the project. The handoff note (the
   * entry tagged `handoff`, newest if there are several) leads and is rendered whole — it is the
   * one thing a resuming session must not lose the end of — and up to `limit` further entries
   * follow by importance. Stale handoffs are left out rather than listed as notes.
   */
  private async renderPersonal(scope: string, limit: number): Promise<{ text: string; handoff: boolean }> {
    const handoffs = await this.deps.memory.list({ category: scope, tag: HANDOFF_TAG, limit: 20 });
    const handoff = handoffs.length ? handoffs.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a)) : null;
    const pool = limit > 0 ? await this.deps.memory.list({ category: scope, limit: limit + handoffs.length }) : [];
    const notes = pool.filter((e) => !e.tags.includes(HANDOFF_TAG)).slice(0, limit);

    const lines: string[] = [`# Your thread in ${scope}`];
    if (handoff) {
      lines.push(`## Handoff (updated ${handoff.updatedAt})`);
      lines.push(handoff.content.trim());
    }
    if (notes.length) {
      if (handoff) lines.push('');
      lines.push('## Notes');
      for (const e of notes) lines.push(memoryLine(e));
    }
    if (!handoff && !notes.length) lines.push('(no personal thread in this project yet)');
    return { text: lines.join('\n'), handoff: handoff !== null };
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
    await this.deps.store.run(
      `INSERT INTO context_snapshots (id, scope, query, prompt, chars, memory_hits, docs_count, session_msgs, assembled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope) DO UPDATE SET
         query=excluded.query, prompt=excluded.prompt, chars=excluded.chars,
         memory_hits=excluded.memory_hits, docs_count=excluded.docs_count,
         session_msgs=excluded.session_msgs, assembled_at=excluded.assembled_at`,
      [newId('snap'), scope, query, snap.prompt, snap.chars, snap.memoryHits, snap.docs, snap.sessionMsgs, snap.assembledAt],
    );
    return snap;
  }

  /** Read the latest persisted context snapshot for a scope, or null. */
  async getSnapshot(scope: string): Promise<ContextSnapshot | null> {
    const r = await this.deps.store.get<Record<string, unknown>>(
      'SELECT scope, query, prompt, chars, memory_hits, docs_count, session_msgs, assembled_at FROM context_snapshots WHERE scope = ?',
      [scope],
    );
    if (!r) return null;
    return {
      scope: r.scope as string,
      query: r.query as string,
      prompt: r.prompt as string,
      chars: Number(r.chars),
      memoryHits: Number(r.memory_hits),
      docs: Number(r.docs_count),
      sessionMsgs: Number(r.session_msgs),
      assembledAt: r.assembled_at as string,
    };
  }

  /** Distinct scopes that hold any context-bearing data or a project row (scheduler targets). */
  async targetScopes(): Promise<string[]> {
    const rows = await this.deps.store.all<{ scope: string }>(
      `SELECT scope FROM (
         SELECT DISTINCT category AS scope FROM memory
         UNION SELECT DISTINCT scope FROM docs
         UNION SELECT DISTINCT scope FROM sessions
         UNION SELECT DISTINCT slug AS scope FROM projects
       ) AS scopes WHERE scope IS NOT NULL AND scope != ''`,
    );
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

  async getBrief(scope: string): Promise<ProjectBrief | null> {
    const r = await this.deps.store.get<{ brief_json: string }>('SELECT brief_json FROM context_briefs WHERE scope = ?', [scope]);
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
  async saveBrief(scope: string, partial: Partial<ProjectBrief>): Promise<ProjectBrief> {
    const prev = (await this.getBrief(scope)) ?? this.emptyBrief(scope);
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
    await this.persistBrief(brief);
    return brief;
  }

  /** Append a decision/convention to the brief's historic log. */
  async addDecision(scope: string, input: { title: string; decision: string; rationale?: string }): Promise<ProjectBrief> {
    const prev = (await this.getBrief(scope)) ?? this.emptyBrief(scope);
    prev.decisionLog = prev.decisionLog ?? [];
    prev.decisionLog.push({
      id: newId('dec'),
      title: input.title,
      decision: input.decision,
      rationale: input.rationale ?? '',
      at: new Date().toISOString(),
    });
    prev.updatedAt = nowIso();
    await this.persistBrief(prev);
    return prev;
  }

  /** Build a starter brief from the project's current top memory + docs (used for first-time seeding). */
  async seedBrief(scope: string): Promise<ProjectBrief> {
    const prev = (await this.getBrief(scope)) ?? this.emptyBrief(scope);
    const topMem = await this.deps.memory.list({ category: scope, limit: 12 });
    const topDocs = await this.deps.docs.list({ scope, limit: 8 });
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
    await this.persistBrief(brief);
    return brief;
  }

  private async persistBrief(brief: ProjectBrief): Promise<void> {
    await this.deps.store.run(
      'INSERT INTO context_briefs (scope, brief_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(scope) DO UPDATE SET brief_json=excluded.brief_json, updated_at=excluded.updated_at',
      [brief.scope, JSON.stringify(brief), brief.updatedAt],
    );
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
  private async renderBrief(scope: string, budgetChars: number): Promise<string> {
    const brief = await this.getBrief(scope);
    if (brief === null) return '';
    return this.renderBriefParts(`# Project brief: ${scope} (updated ${brief.updatedAt})\n`, brief, budgetChars);
  }

  /** The brief's sections and decision log under `header`, within `budgetChars` (header included). */
  private renderBriefParts(header: string, brief: ProjectBrief, budgetChars: number): string {
    const section = (label: string, body: string): string => (body.trim() ? `## ${label}\n${body.trim()}\n` : '');
    const parts: string[] = [header];

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
