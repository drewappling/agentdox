import type { Session, SessionMessage } from '@agentdox/types';
import type { Store } from './db.js';
import { newId, nowIso, parseJsonArray } from './util.js';

type SessionRow = {
  id: string;
  scope: string;
  title: string;
  started_at: string;
  ended_at: string | null;
};

type MessageRow = {
  role: string;
  content: string;
  at: string;
  refs_json: string;
};

export class SessionService {
  constructor(private readonly store: Store) {}

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
      .prepare('SELECT role, content, at, refs_json FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT ?')
      .all(sessionId, limit) as MessageRow[];
    return rows.map((r) => ({
      role: r.role as SessionMessage['role'],
      content: r.content,
      at: r.at,
      refs: parseJsonArray<string>(r.refs_json),
    }));
  }

  append(sessionId: string, message: Omit<SessionMessage, 'at'>): SessionMessage | null {
    const session = this.get(sessionId);
    if (!session) return null;
    const full: SessionMessage = { ...message, at: nowIso() };
    this.store.db
      .prepare('INSERT INTO messages (session_id, role, content, at, refs_json) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, full.role, full.content, full.at, JSON.stringify(full.refs ?? []));
    return full;
  }

  end(sessionId: string): Session | null {
    const res = this.store.db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(nowIso(), sessionId);
    if (res.changes === 0) return null;
    return this.get(sessionId);
  }

  /** Permanently delete a session and its messages (cascades via FK). */
  remove(sessionId: string): boolean {
    const res = this.store.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    return res.changes > 0;
  }

  /** Latest messages across a scope, newest first (for context assembly). */
  recentMessages(scope: string, limit = 20): SessionMessage[] {
    const rows = this.store.db
      .prepare(
        `SELECT m.role, m.content, m.at, m.refs_json
         FROM messages m JOIN sessions s ON s.id = m.session_id
         WHERE s.scope = ?
         ORDER BY m.id DESC LIMIT ?`,
      )
      .all(scope, limit) as MessageRow[];
    return rows
      .reverse()
      .map((r) => ({
        role: r.role as SessionMessage['role'],
        content: r.content,
        at: r.at,
        refs: parseJsonArray<string>(r.refs_json),
      }));
  }
}