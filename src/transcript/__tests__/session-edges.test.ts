import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TranscriptDb } from '../db.js';
import { detectSessionEdges, storeSessionEdges } from '../session-edges.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let db: TranscriptDb;
let dbPath: string;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `memento-edges-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = new TranscriptDb(dbPath);
});

afterEach(() => {
  db.close();
  try { fs.unlinkSync(dbPath); } catch {}
});

describe('detectSessionEdges', () => {
  it('detects continuation when sessions are close in time', () => {
    const now = Date.now();

    // Create sessions manually with controlled timestamps
    db.ensureSession('s1', 'proj1');
    db.ensureSession('s2', 'proj1');

    // Simulate endSession for s1 (set ended_at)
    db.transaction(() => {
      // Hack: directly manipulate for testing
      (db as any).db.prepare('UPDATE sessions SET started_at = ?, ended_at = ? WHERE id = ?')
        .run(now - 3600000, now - 3500000, 's1'); // 1h ago, ended 58min ago
      (db as any).db.prepare('UPDATE sessions SET started_at = ? WHERE id = ?')
        .run(now - 3400000, 's2'); // started 56min ago (100s gap)
    });

    const edges = detectSessionEdges(db, 'proj1');
    expect(edges).toHaveLength(1);
    expect(edges[0].relationship).toBe('continuation');
    expect(edges[0].sourceSession).toBe('s1');
    expect(edges[0].targetSession).toBe('s2');
    expect(edges[0].strength).toBeGreaterThan(0.5);
  });

  it('does not link sessions far apart', () => {
    const now = Date.now();

    db.ensureSession('s1', 'proj1');
    db.ensureSession('s2', 'proj1');

    db.transaction(() => {
      (db as any).db.prepare('UPDATE sessions SET started_at = ?, ended_at = ? WHERE id = ?')
        .run(now - 86400000, now - 86300000, 's1'); // 24h ago
      (db as any).db.prepare('UPDATE sessions SET started_at = ? WHERE id = ?')
        .run(now, 's2'); // now
    });

    const edges = detectSessionEdges(db, 'proj1');
    expect(edges).toHaveLength(0);
  });

  it('returns empty for single session', () => {
    db.ensureSession('s1', 'proj1');
    const edges = detectSessionEdges(db, 'proj1');
    expect(edges).toHaveLength(0);
  });
});

describe('storeSessionEdges', () => {
  it('stores edges in db', () => {
    db.ensureSession('s1', 'proj1');
    db.ensureSession('s2', 'proj1');

    const edges = [
      { sourceSession: 's1', targetSession: 's2', relationship: 'continuation' as const, strength: 0.9 },
    ];

    const stored = storeSessionEdges(db, edges);
    expect(stored).toBe(1);

    const neighbors = db.getSessionNeighbors('s1');
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0].sessionId).toBe('s2');
    expect(neighbors[0].direction).toBe('next');
  });

  it('retrieves bidirectional neighbors', () => {
    db.ensureSession('s1', 'proj1');
    db.ensureSession('s2', 'proj1');

    storeSessionEdges(db, [
      { sourceSession: 's1', targetSession: 's2', relationship: 'continuation' as const, strength: 0.9 },
    ]);

    // From s2's perspective, s1 is a 'prev' neighbor
    const neighbors = db.getSessionNeighbors('s2');
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0].sessionId).toBe('s1');
    expect(neighbors[0].direction).toBe('prev');
  });
});
