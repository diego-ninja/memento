import Database from 'better-sqlite3';
import type { Memory } from '../types.js';
import fs from 'node:fs';
import path from 'node:path';

export class SqliteStorage {
  private db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        project TEXT NOT NULL,
        scope TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL,
        embedding BLOB NOT NULL,
        session_id TEXT NOT NULL,
        supersedes TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp);
    `);
  }

  store(memory: Memory): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO memories (id, timestamp, project, scope, type, content, tags, embedding, session_id, supersedes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      memory.id,
      memory.timestamp,
      memory.project,
      memory.scope,
      memory.type,
      memory.content,
      JSON.stringify(memory.tags),
      Buffer.from(new Float32Array(memory.embedding).buffer),
      memory.sessionId,
      memory.supersedes ?? null,
    );
  }

  getById(id: string): Memory | undefined {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as any;
    return row ? this.rowToMemory(row) : undefined;
  }

  listByProject(project: string): Memory[] {
    const rows = this.db
      .prepare('SELECT * FROM memories WHERE project = ? ORDER BY timestamp DESC')
      .all(project) as any[];
    return rows.map(this.rowToMemory);
  }

  getAll(): Memory[] {
    const rows = this.db
      .prepare('SELECT * FROM memories ORDER BY timestamp DESC')
      .all() as any[];
    return rows.map(this.rowToMemory);
  }

  close(): void {
    this.db.close();
  }

  private rowToMemory(row: any): Memory {
    return {
      id: row.id,
      timestamp: row.timestamp,
      project: row.project,
      scope: row.scope,
      type: row.type,
      content: row.content,
      tags: JSON.parse(row.tags),
      embedding:
        row.embedding.length > 0
          ? Array.from(new Float32Array(new Uint8Array(row.embedding).buffer))
          : [],
      sessionId: row.session_id,
      supersedes: row.supersedes ?? undefined,
    };
  }
}
