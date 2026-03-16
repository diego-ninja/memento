import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type MessageRole = 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'thinking';

export interface TranscriptMessage {
  id: string;
  sessionId: string;
  ordinal: number;
  role: MessageRole;
  content: string;
  tokenCount: number;
  timestamp: number;
}

export interface Session {
  id: string;
  project: string;
  startedAt: number;
  endedAt: number | null;
  totalMessages: number;
  totalTokens: number;
  rootSummaryId: string | null;
  metadata: string | null;
}

export class TranscriptDb {
  private db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        total_messages INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        root_summary_id TEXT,
        metadata TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id),
        UNIQUE(session_id, ordinal)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, ordinal);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);

      CREATE TABLE IF NOT EXISTS summaries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        level INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS summary_sources (
        summary_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        PRIMARY KEY (summary_id, source_id),
        FOREIGN KEY (summary_id) REFERENCES summaries(id)
      );

      CREATE INDEX IF NOT EXISTS idx_summary_sources_source ON summary_sources(source_id);
      CREATE INDEX IF NOT EXISTS idx_summaries_session ON summaries(session_id);
      CREATE INDEX IF NOT EXISTS idx_summaries_level ON summaries(session_id, level);

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_type TEXT,
        token_count INTEGER,
        exploration_summary TEXT,
        first_seen INTEGER NOT NULL,
        last_accessed INTEGER,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_artifacts_path ON artifacts(file_path);
      CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id);

      CREATE TABLE IF NOT EXISTS session_edges (
        source_session TEXT NOT NULL,
        target_session TEXT NOT NULL,
        relationship TEXT NOT NULL,
        strength REAL NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (source_session, target_session),
        FOREIGN KEY (source_session) REFERENCES sessions(id),
        FOREIGN KEY (target_session) REFERENCES sessions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_session_edges_source ON session_edges(source_session);
      CREATE INDEX IF NOT EXISTS idx_session_edges_target ON session_edges(target_session);
    `);

    // FTS5 for full-text search (separate statement — virtual tables can't be in multi-statement exec)
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
          content,
          content='messages',
          content_rowid='rowid'
        );
      `);
      // Trigger to keep FTS in sync
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
        END;
      `);
      // Rebuild FTS index if messages exist but FTS is empty
      const msgCount = (this.db.prepare('SELECT COUNT(*) as c FROM messages').get() as any)?.c ?? 0;
      const ftsCount = (this.db.prepare('SELECT COUNT(*) as c FROM messages_fts').get() as any)?.c ?? 0;
      if (msgCount > 0 && ftsCount === 0) {
        this.db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
      }
    } catch {
      // FTS5 may not be available in all SQLite builds — degrade gracefully
    }
  }

  // -- Sessions --

  ensureSession(sessionId: string, project: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO sessions (id, project, started_at)
      VALUES (?, ?, ?)
    `).run(sessionId, project, Date.now());
  }

  getSession(sessionId: string): Session | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as any;
    return row ? this.rowToSession(row) : undefined;
  }

  getRecentSessions(project: string, limit: number): Session[] {
    if (project) {
      const rows = this.db.prepare(`
        SELECT * FROM sessions WHERE project = ?
        ORDER BY started_at DESC LIMIT ?
      `).all(project, limit) as any[];
      return rows.map(r => this.rowToSession(r));
    }
    // All projects
    const rows = this.db.prepare(`
      SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?
    `).all(limit) as any[];
    return rows.map(r => this.rowToSession(r));
  }

  endSession(sessionId: string): void {
    const stats = this.db.prepare(`
      SELECT COUNT(*) as cnt, COALESCE(SUM(token_count), 0) as tokens
      FROM messages WHERE session_id = ?
    `).get(sessionId) as any;

    this.db.prepare(`
      UPDATE sessions SET ended_at = ?, total_messages = ?, total_tokens = ?
      WHERE id = ?
    `).run(Date.now(), stats.cnt, stats.tokens, sessionId);
  }

  setSessionRootSummary(sessionId: string, summaryId: string): void {
    this.db.prepare('UPDATE sessions SET root_summary_id = ? WHERE id = ?')
      .run(summaryId, sessionId);
  }

  // -- Messages --

  getNextOrdinal(sessionId: string): number {
    const row = this.db.prepare(
      'SELECT MAX(ordinal) as max_ord FROM messages WHERE session_id = ?'
    ).get(sessionId) as any;
    return (row?.max_ord ?? -1) + 1;
  }

  insertMessage(msg: TranscriptMessage): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO messages (id, session_id, ordinal, role, content, token_count, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(msg.id, msg.sessionId, msg.ordinal, msg.role, msg.content, msg.tokenCount, msg.timestamp);
  }

  getMessage(id: string): TranscriptMessage | undefined {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as any;
    return row ? this.rowToMessage(row) : undefined;
  }

  getMessagesBySession(sessionId: string): TranscriptMessage[] {
    const rows = this.db.prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY ordinal'
    ).all(sessionId) as any[];
    return rows.map(r => this.rowToMessage(r));
  }

  getMessagesAround(sessionId: string, ordinal: number, window: number): TranscriptMessage[] {
    const half = Math.floor(window / 2);
    const rows = this.db.prepare(`
      SELECT * FROM messages WHERE session_id = ? AND ordinal BETWEEN ? AND ?
      ORDER BY ordinal
    `).all(sessionId, ordinal - half, ordinal + half) as any[];
    return rows.map(r => this.rowToMessage(r));
  }

  getMessageCount(sessionId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?'
    ).get(sessionId) as any;
    return row?.cnt ?? 0;
  }

  // -- Grep --

  grepMessages(
    pattern: string,
    opts: { sessionId?: string; role?: MessageRole; limit?: number },
  ): (TranscriptMessage & { sessionStartedAt: number })[] {
    // Try FTS5 first, fall back to LIKE if FTS unavailable or returns empty
    const ftsResult = this.tryFtsSearch(pattern, opts);
    if (ftsResult !== null && ftsResult.length > 0) return ftsResult;

    return this.likeSearch(pattern, opts);
  }

  private tryFtsSearch(
    pattern: string,
    opts: { sessionId?: string; role?: MessageRole; limit?: number },
  ): (TranscriptMessage & { sessionStartedAt: number })[] | null {
    try {
      // FTS5 query: quote the pattern for safety
      const ftsQuery = pattern.replace(/"/g, '""');
      const conditions = ['m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)'];
      const params: any[] = [`"${ftsQuery}"`];

      if (opts.sessionId) {
        conditions.push('m.session_id = ?');
        params.push(opts.sessionId);
      }
      if (opts.role) {
        conditions.push('m.role = ?');
        params.push(opts.role);
      }
      params.push(opts.limit ?? 20);

      const sql = `
        SELECT m.*, s.started_at as session_started_at
        FROM messages m
        JOIN sessions s ON s.id = m.session_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY m.timestamp DESC
        LIMIT ?
      `;

      const rows = this.db.prepare(sql).all(...params) as any[];
      return rows.map((r: any) => ({
        ...this.rowToMessage(r),
        sessionStartedAt: r.session_started_at,
      }));
    } catch {
      return null; // FTS not available, fall back to LIKE
    }
  }

  private likeSearch(
    pattern: string,
    opts: { sessionId?: string; role?: MessageRole; limit?: number },
  ): (TranscriptMessage & { sessionStartedAt: number })[] {
    const conditions = ['m.content LIKE ?'];
    const params: any[] = [`%${pattern}%`];

    if (opts.sessionId) {
      conditions.push('m.session_id = ?');
      params.push(opts.sessionId);
    }
    if (opts.role) {
      conditions.push('m.role = ?');
      params.push(opts.role);
    }

    params.push(opts.limit ?? 20);

    const sql = `
      SELECT m.*, s.started_at as session_started_at
      FROM messages m
      JOIN sessions s ON s.id = m.session_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY m.timestamp DESC
      LIMIT ?
    `;

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r: any) => ({
      ...this.rowToMessage(r),
      sessionStartedAt: r.session_started_at,
    }));
  }

  // -- Summaries --

  insertSummary(summary: {
    id: string;
    sessionId: string;
    kind: string;
    content: string;
    tokenCount: number;
    level: number;
  }): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO summaries (id, session_id, kind, content, token_count, level, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(summary.id, summary.sessionId, summary.kind, summary.content, summary.tokenCount, summary.level, Date.now());
  }

  insertSummarySource(summaryId: string, sourceType: string, sourceId: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO summary_sources (summary_id, source_type, source_id)
      VALUES (?, ?, ?)
    `).run(summaryId, sourceType, sourceId);
  }

  getSummary(id: string): { id: string; sessionId: string; kind: string; content: string; tokenCount: number; level: number } | undefined {
    const row = this.db.prepare('SELECT * FROM summaries WHERE id = ?').get(id) as any;
    if (!row) return undefined;
    return {
      id: row.id,
      sessionId: row.session_id,
      kind: row.kind,
      content: row.content,
      tokenCount: row.token_count,
      level: row.level,
    };
  }

  getSummarySources(summaryId: string): { sourceType: string; sourceId: string }[] {
    const rows = this.db.prepare(
      'SELECT source_type, source_id FROM summary_sources WHERE summary_id = ?'
    ).all(summaryId) as any[];
    return rows.map((r: any) => ({ sourceType: r.source_type, sourceId: r.source_id }));
  }

  getSummariesBySession(sessionId: string, level?: number): { id: string; content: string; level: number; tokenCount: number }[] {
    if (level !== undefined) {
      return this.db.prepare(
        'SELECT id, content, level, token_count FROM summaries WHERE session_id = ? AND level = ? ORDER BY rowid'
      ).all(sessionId, level) as any[];
    }
    return this.db.prepare(
      'SELECT id, content, level, token_count FROM summaries WHERE session_id = ? ORDER BY level, rowid'
    ).all(sessionId) as any[];
  }

  getRootSummary(sessionId: string): string | null {
    const session = this.getSession(sessionId);
    if (!session?.rootSummaryId) return null;
    const summary = this.getSummary(session.rootSummaryId);
    return summary?.content ?? null;
  }

  // -- Resolve summary to leaf messages --

  resolveSummaryToMessages(summaryId: string): TranscriptMessage[] {
    const messageIds = new Set<string>();
    const queue = [summaryId];

    while (queue.length > 0) {
      const current = queue.pop()!;
      const sources = this.getSummarySources(current);
      for (const source of sources) {
        if (source.sourceType === 'message') {
          messageIds.add(source.sourceId);
        } else {
          queue.push(source.sourceId);
        }
      }
    }

    if (messageIds.size === 0) return [];

    const placeholders = Array.from(messageIds).map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT * FROM messages WHERE id IN (${placeholders}) ORDER BY session_id, ordinal
    `).all(...messageIds) as any[];

    return rows.map(r => this.rowToMessage(r));
  }

  // -- Artifacts --

  upsertArtifact(artifact: {
    id: string;
    sessionId: string;
    filePath: string;
    fileType: string | null;
    tokenCount: number | null;
    firstSeen: number;
  }): void {
    // Check if artifact with same path already exists
    const existing = this.db.prepare(
      'SELECT id FROM artifacts WHERE file_path = ? AND session_id = ?'
    ).get(artifact.filePath, artifact.sessionId) as any;

    if (existing) {
      this.db.prepare('UPDATE artifacts SET last_accessed = ? WHERE id = ?')
        .run(artifact.firstSeen, existing.id);
      return;
    }

    this.db.prepare(`
      INSERT INTO artifacts (id, session_id, file_path, file_type, token_count, first_seen, last_accessed)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      artifact.id, artifact.sessionId, artifact.filePath,
      artifact.fileType, artifact.tokenCount,
      artifact.firstSeen, artifact.firstSeen,
    );
  }

  setArtifactSummary(id: string, summary: string): void {
    this.db.prepare('UPDATE artifacts SET exploration_summary = ? WHERE id = ?')
      .run(summary, id);
  }

  getArtifact(id: string): { id: string; sessionId: string; filePath: string; fileType: string | null; tokenCount: number | null; explorationSummary: string | null } | undefined {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as any;
    if (!row) return undefined;
    return {
      id: row.id,
      sessionId: row.session_id,
      filePath: row.file_path,
      fileType: row.file_type,
      tokenCount: row.token_count,
      explorationSummary: row.exploration_summary,
    };
  }

  getArtifactByPath(filePath: string): { id: string; sessionId: string; filePath: string; fileType: string | null; tokenCount: number | null; explorationSummary: string | null } | undefined {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE file_path = ? ORDER BY last_accessed DESC LIMIT 1').get(filePath) as any;
    if (!row) return undefined;
    return {
      id: row.id,
      sessionId: row.session_id,
      filePath: row.file_path,
      fileType: row.file_type,
      tokenCount: row.token_count,
      explorationSummary: row.exploration_summary,
    };
  }

  getArtifactsBySession(sessionId: string): { id: string; filePath: string; fileType: string | null; tokenCount: number | null }[] {
    const rows = this.db.prepare(
      'SELECT id, file_path, file_type, token_count FROM artifacts WHERE session_id = ? ORDER BY first_seen'
    ).all(sessionId) as any[];
    return rows.map((r: any) => ({
      id: r.id,
      filePath: r.file_path,
      fileType: r.file_type,
      tokenCount: r.token_count,
    }));
  }

  // -- Session Edges --

  insertSessionEdge(edge: { sourceSession: string; targetSession: string; relationship: string; strength: number }): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO session_edges (source_session, target_session, relationship, strength)
      VALUES (?, ?, ?, ?)
    `).run(edge.sourceSession, edge.targetSession, edge.relationship, edge.strength);
  }

  getSessionNeighbors(sessionId: string): { sessionId: string; relationship: string; strength: number; direction: 'next' | 'prev' }[] {
    const forward = this.db.prepare(`
      SELECT target_session, relationship, strength FROM session_edges
      WHERE source_session = ? ORDER BY strength DESC
    `).all(sessionId) as any[];

    const backward = this.db.prepare(`
      SELECT source_session, relationship, strength FROM session_edges
      WHERE target_session = ? ORDER BY strength DESC
    `).all(sessionId) as any[];

    return [
      ...forward.map((r: any) => ({ sessionId: r.target_session, relationship: r.relationship, strength: r.strength, direction: 'next' as const })),
      ...backward.map((r: any) => ({ sessionId: r.source_session, relationship: r.relationship, strength: r.strength, direction: 'prev' as const })),
    ];
  }

  // -- Helpers --

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  private rowToSession(row: any): Session {
    return {
      id: row.id,
      project: row.project,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      totalMessages: row.total_messages,
      totalTokens: row.total_tokens,
      rootSummaryId: row.root_summary_id,
      metadata: row.metadata,
    };
  }

  private rowToMessage(row: any): TranscriptMessage {
    return {
      id: row.id,
      sessionId: row.session_id,
      ordinal: row.ordinal,
      role: row.role,
      content: row.content,
      tokenCount: row.token_count,
      timestamp: row.timestamp,
    };
  }
}
