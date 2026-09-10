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
  ...(r.id === undefined ? {} : { id: Number(r.id) }),
  role: r.role as SessionMessage['role'],
  content: r.content,
  at: r.at,
  refs: parseJsonArray<string>(r.refs_json),
});

const toSession = (r: SessionRow, messages: SessionMessage[]): Session => ({
  id: r.id,
  scope: r.scope,
  title: r.title,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  messages,
});

export class SessionService {
  private indexer: IndexService | null = null;

  constructor(private readonly store: Store) {}

  /** Wired by `AgentDox`; without it messages are stored but not searchable. */
  setIndexer(indexer: IndexService): void {
    this.indexer = indexer;
  }

  async create(input: { scope: string; title?: string; id?: string }): Promise<Session> {
    const now = nowIso();
    const session: Session = {
      id: input.id ?? newId('ses'),
      scope: input.scope,
      title: input.title ?? input.scope,
      startedAt: now,
      endedAt: null,
      messages: [],
    };
    await this.store.run('INSERT INTO sessions (id, scope, title, started_at, ended_at) VALUES (?, ?, ?, ?, ?)', [
      session.id,
      session.scope,
      session.title,
      session.startedAt,
      null,
    ]);
    return session;
  }

  async get(id: string): Promise<Session | null> {
    const row = await this.store.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', [id]);
    if (!row) return null;
    return toSession(row, await this.messages(id));
  }

  async list(scope?: string, limit = 50): Promise<Session[]> {
    const rows = scope
      ? await this.store.all<SessionRow>('SELECT * FROM sessions WHERE scope = ? ORDER BY started_at DESC LIMIT ?', [scope, limit])
      : await this.store.all<SessionRow>('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?', [limit]);
    return rows.map((r) => toSession(r, []));
  }

  async messages(sessionId: string, limit = 1000): Promise<SessionMessage[]> {
    const rows = await this.store.all<MessageRow>(
      'SELECT id, role, content, at, refs_json FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT ?',
      [sessionId, limit],
    );
    return rows.map(toMessage);
  }

  async append(sessionId: string, message: Omit<SessionMessage, 'at'>): Promise<SessionMessage | null> {
    // Only the scope is needed to index the message; loading the full history (messages(), up to
    // 1000 rows + JSON parse) on every turn was O(history) work just to check existence.
    const row = await this.store.get<{ scope: string }>('SELECT scope FROM sessions WHERE id = ?', [sessionId]);
    if (!row) return null;
    const full: SessionMessage = { ...message, at: nowIso() };
    const id = await this.store.tx(async () => {
      const inserted = await this.store.get<{ id: number }>(
        'INSERT INTO messages (session_id, role, content, at, refs_json) VALUES (?, ?, ?, ?, ?) RETURNING id',
        [sessionId, full.role, full.content, full.at, JSON.stringify(full.refs ?? [])],
      );
      const msgId = Number(inserted?.id);
      await this.indexer?.indexMessage({ id: msgId, scope: row.scope, role: full.role, content: full.content });
      return msgId;
    });
    return { ...full, id };
  }

  async end(sessionId: string): Promise<Session | null> {
    const res = await this.store.run('UPDATE sessions SET ended_at = ? WHERE id = ?', [nowIso(), sessionId]);
    if (res.changes === 0) return null;
    return this.get(sessionId);
  }

  /**
   * Write a session exactly as given and replace its messages with the ones it carries. The
   * import path. Message ids are the engine's, so the copies get fresh ones (and fresh index
   * rows); what is preserved is the conversation — role, content, time, refs — in order.
   * Returns how many messages were written.
   */
  async upsert(session: Session): Promise<number> {
    return this.store.tx(async () => {
      await this.store.run(
        `INSERT INTO sessions (id, scope, title, started_at, ended_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET scope = excluded.scope, title = excluded.title, started_at = excluded.started_at, ended_at = excluded.ended_at`,
        [session.id, session.scope, session.title, session.startedAt, session.endedAt ?? null],
      );
      await this.indexer?.removeSessionMessages(session.id);
      await this.store.run('DELETE FROM messages WHERE session_id = ?', [session.id]);
      const messages = session.messages ?? [];
      for (const m of messages) {
        const inserted = await this.store.get<{ id: number }>(
          'INSERT INTO messages (session_id, role, content, at, refs_json) VALUES (?, ?, ?, ?, ?) RETURNING id',
          [session.id, m.role, m.content, m.at, JSON.stringify(m.refs ?? [])],
        );
        await this.indexer?.indexMessage({ id: Number(inserted?.id), scope: session.scope, role: m.role, content: m.content });
      }
      return messages.length;
    });
  }

  /** Permanently delete a session and its messages (cascades via FK). */
  async remove(sessionId: string): Promise<boolean> {
    await this.indexer?.removeSessionMessages(sessionId); // before the cascade drops the rows
    const res = await this.store.run('DELETE FROM sessions WHERE id = ?', [sessionId]);
    return res.changes > 0;
  }

  /**
   * Latest messages across a scope, oldest-first within the window (for context assembly).
   * With `user`, only messages whose refs carry `user:<user>` — one member's own tail of a
   * shared project conversation. The ref is written by the recorder (the router tags each
   * turn with the harness id); messages recorded without one belong to nobody in particular
   * and are left out of a filtered tail.
   */
  async recentMessages(scope: string, limit = 20, user?: string): Promise<SessionMessage[]> {
    const userClause = user ? ` AND ${this.store.sql.jsonArrayHas('m.refs_json')}` : '';
    const rows = await this.store.all<MessageRow>(
      `SELECT m.id, m.role, m.content, m.at, m.refs_json
       FROM messages m JOIN sessions s ON s.id = m.session_id
       WHERE s.scope = ?${userClause}
       ORDER BY m.id DESC LIMIT ?`,
      user ? [scope, `user:${user}`, limit] : [scope, limit],
    );
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

    const lists = [await lexicalSearch(this.store, 'message_fts', query, { scope, limit: pool })];
    const provider = this.indexer?.embeddingProvider;
    if (provider) {
      try {
        const [queryVec] = await provider.embed([query], 'query');
        if (queryVec) {
          lists.push(await vectorSearch(this.store, 'message', queryVec, { scope, limit: pool, model: provider.model }));
        }
      } catch {
        // Provider unreachable: lexical-only, as everywhere else.
      }
    }

    const fused = fuseRRF(lists.filter((l) => l.length));
    if (!fused.length) return [];

    const out: SessionMessage[] = [];
    for (const row of fused) {
      const id = Number(row.id);
      if (opts.exclude?.has(id)) continue;
      const r = await this.store.get<MessageRow>('SELECT id, role, content, at, refs_json FROM messages WHERE id = ?', [id]);
      if (!r) continue;
      out.push(toMessage(r));
      if (out.length >= limit) break;
    }
    // Chronological, so the block still reads as a conversation rather than a ranked list.
    return out.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  }
}
