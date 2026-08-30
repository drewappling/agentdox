import type { Session, SessionMessage } from '@agentdox/types';
import type { Store } from './db.js';
import { newId, nowIso, parseJsonArray } from './util.js';
import type { IndexService } from './indexer.js';
import { fuseRRF, lexicalSearch, vectorSearch } from './retrieval.js';

type SessionRow = {
  id: string;
  scope: string;
  title: string;
  started_at: string;
  ended_at: string | null;
};

type MessageRow = {
  id?: number;
  role: string;
  content: string;
  at: string;
  refs_json: string;
};

const toMessage = (r: MessageRow): SessionMessage => ({
  ...(r.id === undefined ? {} : { id: r.id }),
  role: r.role as SessionMessage['role'],
  content: r.content,
  at: r.at,
  refs: parseJsonArray<string>(r.refs_json),
});

export class SessionService {
  private indexer: IndexService | null = null;

  constructor(private readonly store: Store) {}

  /** Wired by `AgentDox`; without it messages are stored but not searchable. */
  setIndexer(indexer: IndexService): void {
    this.indexer = indexer;
  }

  create(input: { scope: string; title?: string; id?: string }): Session {
    const now = nowIso();
    const session: Session = {
      id: input.id ?? newId('ses'),
      scope: input.scope,
      title: input.title ?? input.scope,
      startedAt: now,
      endedAt: null,
      messages: [],
    };
    this.store.db
      .prepare('INSERT INTO sessions (id, scope, title, started_at, ended_at) VALUES (?, ?, ?, ?, ?)')
      .run(session.id, session.scope, session.title, session.startedAt, null);
    return session;
  }

  get(id: string): Session | null {
    const row = this.store.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    if (!row) return null;
    const messages = this.messages(id);
    return {
      id: row.id,
      scope: row.scope,
      title: row.title,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      messages,
    };
  }

  list(scope?: string, limit = 50): Session[] {
    const rows = scope
      ? (this.store.db.prepare('SELECT * FROM sessions WHERE scope = ? ORDER BY started_at DESC LIMIT ?').all(scope, limit) as SessionRow[])
      : (this.store.db.prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?').all(limit) as SessionRow[]);
    return rows.map((r) => ({
      id: r.id,
      scope: r.scope,
      title: r.title,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      messages: [],
    }));
  }

  messages(sessionId: string, limit = 1000): SessionMessage[] {
    const rows = this.store.db
      .prepare('SELECT id, role, content, at, refs_json FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT ?')
      .all(sessionId, limit) as MessageRow[];
    return rows.map(toMessage);
  }

  append(sessionId: string, message: Omit<SessionMessage, 'at'>): SessionMessage | null {
    // Only the scope is needed to index the message; loading the full history (messages(), up to
    // 1000 rows + JSON parse) on every turn was O(history) work just to check existence.
    const row = this.store.db.prepare('SELECT scope FROM sessions WHERE id = ?').get(sessionId) as { scope: string } | undefined;
    if (!row) return null;
    const full: SessionMessage = { ...message, at: nowIso() };
    const id = this.store.tx(() => {
      const res = this.store.db
        .prepare('INSERT INTO messages (session_id, role, content, at, refs_json) VALUES (?, ?, ?, ?, ?)')
        .run(sessionId, full.role, full.content, full.at, JSON.stringify(full.refs ?? []));
      const msgId = Number(res.lastInsertRowid);
      this.indexer?.indexMessage({ id: msgId, scope: row.scope, role: full.role, content: full.content });
      return msgId;
    });
    return { ...full, id };
  }

  end(sessionId: string): Session | null {
    const res = this.store.db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(nowIso(), sessionId);
    if (res.changes === 0) return null;
    return this.get(sessionId);
  }

  /** Permanently delete a session and its messages (cascades via FK). */
  remove(sessionId: string): boolean {
    this.indexer?.removeSessionMessages(sessionId); // before the cascade drops the rows
    const res = this.store.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    return res.changes > 0;
  }

  /** Latest messages across a scope, oldest-first within the window (for context assembly). */
  recentMessages(scope: string, limit = 20): SessionMessage[] {
    const rows = this.store.db
      .prepare(
        `SELECT m.id, m.role, m.content, m.at, m.refs_json
         FROM messages m JOIN sessions s ON s.id = m.session_id
         WHERE s.scope = ?
         ORDER BY m.id DESC LIMIT ?`,
      )
      .all(scope, limit) as MessageRow[];
    return rows.reverse().map(toMessage);
  }

  /**
   * Messages in a scope ranked by relevance to `query`, excluding ids the caller already has.
   *
   * Conversation used to reach context assembly by recency alone, so anything discussed more
   * than `sessionLimit` messages ago was unreachable no matter how directly it answered the
   * question. This is the other half: recency keeps continuity, relevance restores recall.
   */
  async relevantMessages(
    scope: string,
    query: string,
    opts: { limit?: number; exclude?: Set<number> } = {},
  ): Promise<SessionMessage[]> {
    const limit = opts.limit ?? 6;
    if (!query.trim() || limit <= 0) return [];
    const pool = limit * 6;

    const lists = [lexicalSearch(this.store.db, 'message_fts', query, { scope, limit: pool })];
    const provider = this.indexer?.embeddingProvider;
    if (provider) {
      try {
        const [queryVec] = await provider.embed([query], 'query');
        if (queryVec) {
          lists.push(vectorSearch(this.store.db, 'message', queryVec, { scope, limit: pool, model: provider.model }));
        }
      } catch {
        // Provider unreachable: lexical-only, as everywhere else.
      }
    }

    const fused = fuseRRF(lists.filter((l) => l.length));
    if (!fused.length) return [];

    const byId = this.store.db.prepare(
      'SELECT id, role, content, at, refs_json FROM messages WHERE id = ?',
    );
    const out: SessionMessage[] = [];
    for (const row of fused) {
      const id = Number(row.id);
      if (opts.exclude?.has(id)) continue;
      const r = byId.get(id) as MessageRow | undefined;
      if (!r) continue;
      out.push(toMessage(r));
      if (out.length >= limit) break;
    }
    // Chronological, so the block still reads as a conversation rather than a ranked list.
    return out.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  }
}