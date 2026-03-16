import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type { Memory } from '../types.js';
import fs from 'node:fs';
import path from 'node:path';

const EMBEDDING_DIM = 768;

export class UnifiedStorage {
  private db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    sqliteVec.load(this.db);
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

    // FTS5 for text search
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          content,
          content='memories',
          content_rowid='rowid'
        );
        CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
        END;
        CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE OF content ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
          INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
        END;
      `);
    } catch { /* FTS5 might not be available */ }

    // vec0 for vector search
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
          embedding float[${EMBEDDING_DIM}]
        );
      `);
    } catch (e: any) {
      console.error('sqlite-vec initialization failed:', e.message);
    }

    // Rebuild indexes if memories exist but vec/fts are empty
    this.rebuildIndexesIfNeeded();
  }

  private rebuildIndexesIfNeeded(): void {
    const memCount = (this.db.prepare('SELECT COUNT(*) as c FROM memories').get() as any)?.c ?? 0;
    if (memCount === 0) return;

    // Rebuild FTS
    try {
      const ftsCount = (this.db.prepare('SELECT COUNT(*) as c FROM memories_fts').get() as any)?.c ?? 0;
      if (ftsCount === 0) {
        this.db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
      }
    } catch { /* FTS not available */ }

    // Rebuild vec
    try {
      const vecCount = (this.db.prepare('SELECT COUNT(*) as c FROM vec_memories').get() as any)?.c ?? 0;
      if (vecCount === 0) {
        const rows = this.db.prepare('SELECT rowid, embedding FROM memories').all() as any[];
        const tx = this.db.transaction(() => {
          for (const row of rows) {
            if (row.embedding && row.embedding.length > 0) {
              const rowid = Number(row.rowid);
              try {
                this.db.prepare(`INSERT INTO vec_memories(rowid, embedding) VALUES (${rowid}, ?)`).run(row.embedding);
              } catch { /* skip duplicate or invalid */ }
            }
          }
        });
        tx();
      }
    } catch { /* vec not available */ }
  }

  // -- Store --

  store(memory: Memory): void {
    const embeddingBlob = Buffer.from(new Float32Array(memory.embedding).buffer);

    const info = this.db.prepare(`
      INSERT OR REPLACE INTO memories (id, timestamp, project, scope, type, content, tags, embedding, session_id, supersedes, is_core, recall_count, last_recalled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      memory.id, memory.timestamp, memory.project, memory.scope,
      memory.type, memory.content, JSON.stringify(memory.tags),
      embeddingBlob, memory.sessionId, memory.supersedes ?? null,
      memory.isCore ? 1 : 0, memory.recallCount, memory.lastRecalled,
    );

    // Update vec index (rowid must be embedded in SQL — sqlite-vec rejects parameterized rowids)
    if (memory.embedding.length > 0) {
      try {
        const rowid = Number(info.lastInsertRowid);
        this.db.exec(`DELETE FROM vec_memories WHERE rowid = ${rowid}`);
        this.db.prepare(`INSERT INTO vec_memories(rowid, embedding) VALUES (${rowid}, ?)`).run(
          new Float32Array(memory.embedding),
        );
      } catch { /* vec not available */ }
    }
  }

  // -- Retrieve --

  getById(id: string): Memory | undefined {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as any;
    return row ? this.rowToMemory(row) : undefined;
  }

  getAll(): Memory[] {
    const rows = this.db.prepare('SELECT * FROM memories ORDER BY timestamp DESC').all() as any[];
    return rows.map(r => this.rowToMemory(r));
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) as c FROM memories').get() as any;
    return row?.c ?? 0;
  }

  // -- Search --

  searchText(query: string, limit: number = 20): Memory[] {
    // Try FTS5 first
    try {
      const escaped = query.replace(/"/g, '""');
      const rows = this.db.prepare(`
        SELECT m.* FROM memories_fts f
        JOIN memories m ON m.rowid = f.rowid
        WHERE memories_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(`"${escaped}"`, limit) as any[];
      if (rows.length > 0) return rows.map(r => this.rowToMemory(r));
    } catch { /* FTS not available */ }

    // Fallback to LIKE
    const rows = this.db.prepare(`
      SELECT * FROM memories WHERE content LIKE ?
      ORDER BY timestamp DESC LIMIT ?
    `).all(`%${query}%`, limit) as any[];
    return rows.map(r => this.rowToMemory(r));
  }

  searchVector(embedding: number[], limit: number = 20): Memory[] {
    try {
      const buffer = new Float32Array(embedding);
      // vec0 requires LIMIT in the inner query, not on the outer JOIN
      const rows = this.db.prepare(`
        SELECT m.* FROM (
          SELECT rowid, distance FROM vec_memories
          WHERE embedding MATCH ? AND k = ?
        ) v
        JOIN memories m ON m.rowid = v.rowid
        ORDER BY v.distance
      `).all(buffer, limit) as any[];
      return rows.map(r => this.rowToMemory(r));
    } catch {
      return [];
    }
  }

  // -- Core --

  getCoreMemories(): Memory[] {
    const rows = this.db.prepare(
      'SELECT * FROM memories WHERE is_core = 1 ORDER BY timestamp DESC'
    ).all() as any[];
    return rows.map(r => this.rowToMemory(r));
  }

  incrementRecallCount(id: string): void {
    this.db.prepare(
      'UPDATE memories SET recall_count = recall_count + 1, last_recalled = ? WHERE id = ?'
    ).run(Date.now(), id);
  }

  setCore(id: string, isCore: boolean): void {
    this.db.prepare('UPDATE memories SET is_core = ? WHERE id = ?')
      .run(isCore ? 1 : 0, id);
  }

  // -- Merge / Update --

  mergeContent(id: string, content: string, embedding: number[]): void {
    const embeddingBlob = Buffer.from(new Float32Array(embedding).buffer);
    this.db.prepare(
      'UPDATE memories SET content = ?, embedding = ?, timestamp = ? WHERE id = ?'
    ).run(content, embeddingBlob, Date.now(), id);

    // Update vec index
    try {
      const row = this.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as any;
      if (row) {
        const rowid = Number(row.rowid);
        this.db.exec(`DELETE FROM vec_memories WHERE rowid = ${rowid}`);
        this.db.prepare(`INSERT INTO vec_memories(rowid, embedding) VALUES (${rowid}, ?)`).run(
          new Float32Array(embedding),
        );
      }
    } catch { /* vec not available */ }
  }

  deleteMemory(id: string): void {
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as any;
      this.db.prepare('DELETE FROM memory_edges WHERE source_id = ? OR target_id = ?').run(id, id);
      this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
      if (row) {
        try { this.db.exec(`DELETE FROM vec_memories WHERE rowid = ${Number(row.rowid)}`); } catch {}
      }
    })();
  }

  // -- Graph --

  addEdge(sourceId: string, targetId: string, similarity: number): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO memory_edges (source_id, target_id, similarity)
      VALUES (?, ?, ?)
    `);
    this.db.transaction(() => {
      stmt.run(sourceId, targetId, similarity);
      stmt.run(targetId, sourceId, similarity);
    })();
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
      this.db.prepare('UPDATE OR IGNORE memory_edges SET source_id = ? WHERE source_id = ? AND target_id != ?')
        .run(toId, fromId, toId);
      this.db.prepare('UPDATE OR IGNORE memory_edges SET target_id = ? WHERE target_id = ? AND source_id != ?')
        .run(toId, fromId, toId);
      this.db.prepare('DELETE FROM memory_edges WHERE source_id = ? OR target_id = ?')
        .run(fromId, fromId);
    })();
  }

  // -- Lifecycle --

  close(): void {
    this.db.close();
  }

  // -- Internal --

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
        row.embedding && row.embedding.length > 0
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
