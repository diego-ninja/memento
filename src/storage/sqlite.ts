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
        is_core INTEGER NOT NULL DEFAULT 0,
        recall_count INTEGER NOT NULL DEFAULT 0,
        last_recalled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp);
      CREATE INDEX IF NOT EXISTS idx_memories_is_core ON memories(is_core);

      CREATE TABLE IF NOT EXISTS memory_edges (
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        similarity REAL NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (source_id, target_id),
        FOREIGN KEY (source_id) REFERENCES memories(id),
        FOREIGN KEY (target_id) REFERENCES memories(id)
      );

      CREATE INDEX IF NOT EXISTS idx_edges_source ON memory_edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON memory_edges(target_id);
    `);

    // Migrate existing DBs: add new columns if missing
    const columns = this.db.pragma('table_info(memories)') as any[];
    const columnNames = columns.map((c: any) => c.name);

    if (!columnNames.includes('is_core')) {
      this.db.exec('ALTER TABLE memories ADD COLUMN is_core INTEGER NOT NULL DEFAULT 0');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_memories_is_core ON memories(is_core)');
    }
    if (!columnNames.includes('recall_count')) {
      this.db.exec('ALTER TABLE memories ADD COLUMN recall_count INTEGER NOT NULL DEFAULT 0');
    }
    if (!columnNames.includes('last_recalled')) {
      this.db.exec('ALTER TABLE memories ADD COLUMN last_recalled INTEGER NOT NULL DEFAULT 0');
    }
  }

  store(memory: Memory): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO memories (id, timestamp, project, scope, type, content, tags, embedding, session_id, supersedes, is_core, recall_count, last_recalled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      memory.isCore ? 1 : 0,
      memory.recallCount,
      memory.lastRecalled,
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

  getCoreMemories(): Memory[] {
    const rows = this.db
      .prepare('SELECT * FROM memories WHERE is_core = 1 ORDER BY timestamp DESC')
      .all() as any[];
    return rows.map(this.rowToMemory);
  }

  incrementRecallCount(id: string): void {
    this.db
      .prepare('UPDATE memories SET recall_count = recall_count + 1, last_recalled = ? WHERE id = ?')
      .run(Date.now(), id);
  }

  setCore(id: string, isCore: boolean): void {
    this.db
      .prepare('UPDATE memories SET is_core = ? WHERE id = ?')
      .run(isCore ? 1 : 0, id);
  }

  mergeContent(id: string, content: string, embeddingBuffer: Buffer): void {
    this.db
      .prepare('UPDATE memories SET content = ?, embedding = ?, timestamp = ? WHERE id = ?')
      .run(content, embeddingBuffer, Date.now(), id);
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
      isCore: row.is_core === 1,
      recallCount: row.recall_count ?? 0,
      lastRecalled: row.last_recalled ?? 0,
    };
  }
}
