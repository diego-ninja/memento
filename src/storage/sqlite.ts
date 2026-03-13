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
    // 1. Create tables (no-op if already exist)
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
    `);

    // 2. Migrate existing DBs: add new columns if missing
    const columns = this.db.pragma('table_info(memories)') as any[];
    const columnNames = columns.map((c: any) => c.name);

    if (!columnNames.includes('is_core')) {
      this.db.exec('ALTER TABLE memories ADD COLUMN is_core INTEGER NOT NULL DEFAULT 0');
    }
    if (!columnNames.includes('recall_count')) {
      this.db.exec('ALTER TABLE memories ADD COLUMN recall_count INTEGER NOT NULL DEFAULT 0');
    }
    if (!columnNames.includes('last_recalled')) {
      this.db.exec('ALTER TABLE memories ADD COLUMN last_recalled INTEGER NOT NULL DEFAULT 0');
    }

    // 3. Create indexes and tables that depend on migrated columns
    this.db.exec(`
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
    return rows.map(r => this.rowToMemory(r));
  }

  getAll(): Memory[] {
    const rows = this.db
      .prepare('SELECT * FROM memories ORDER BY timestamp DESC')
      .all() as any[];
    return rows.map(r => this.rowToMemory(r));
  }

  getCoreMemories(): Memory[] {
    const rows = this.db
      .prepare('SELECT * FROM memories WHERE is_core = 1 ORDER BY timestamp DESC')
      .all() as any[];
    return rows.map(r => this.rowToMemory(r));
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

  addEdge(sourceId: string, targetId: string, similarity: number): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO memory_edges (source_id, target_id, similarity)
      VALUES (?, ?, ?)
    `);
    const insert = this.db.transaction(() => {
      stmt.run(sourceId, targetId, similarity);
      stmt.run(targetId, sourceId, similarity);
    });
    insert();
  }

  getNeighbors(memoryId: string): Memory[] {
    const rows = this.db.prepare(`
      SELECT m.* FROM memory_edges e
      JOIN memories m ON m.id = e.target_id
      WHERE e.source_id = ?
      ORDER BY e.similarity DESC
    `).all(memoryId) as any[];
    return rows.map(r => this.rowToMemory(r));
  }

  getNeighborsWithSimilarity(memoryId: string): { memory: Memory; similarity: number }[] {
    const rows = this.db.prepare(`
      SELECT m.*, e.similarity FROM memory_edges e
      JOIN memories m ON m.id = e.target_id
      WHERE e.source_id = ?
      ORDER BY e.similarity DESC
    `).all(memoryId) as any[];
    return rows.map((row: any) => ({
      memory: this.rowToMemory(row),
      similarity: row.similarity,
    }));
  }

  getDegree(memoryId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM memory_edges WHERE source_id = ?'
    ).get(memoryId) as any;
    return row?.cnt ?? 0;
  }

  getDegrees(memoryIds: string[]): Map<string, number> {
    const result = new Map<string, number>();
    if (memoryIds.length === 0) return result;

    const placeholders = memoryIds.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT source_id, COUNT(*) as cnt
      FROM memory_edges
      WHERE source_id IN (${placeholders})
      GROUP BY source_id
    `).all(...memoryIds) as any[];

    for (const id of memoryIds) result.set(id, 0);
    for (const row of rows) result.set(row.source_id, row.cnt);
    return result;
  }

  transferEdges(fromId: string, toId: string): void {
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE OR IGNORE memory_edges SET source_id = ? WHERE source_id = ? AND target_id != ?
      `).run(toId, fromId, toId);
      this.db.prepare(`
        UPDATE OR IGNORE memory_edges SET target_id = ? WHERE target_id = ? AND source_id != ?
      `).run(toId, fromId, toId);
      this.db.prepare('DELETE FROM memory_edges WHERE source_id = ? OR target_id = ?').run(fromId, fromId);
    })();
  }

  deleteMemory(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM memory_edges WHERE source_id = ? OR target_id = ?').run(id, id);
      this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    })();
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
