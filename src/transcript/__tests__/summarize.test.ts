import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TranscriptDb } from '../db.js';
import { deterministicTruncate, chunkMessages, chunkArray, buildSummaryDAG } from '../summarize.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let db: TranscriptDb;
let dbPath: string;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `memento-summarize-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = new TranscriptDb(dbPath);
});

afterEach(() => {
  db.close();
  try { fs.unlinkSync(dbPath); } catch {}
});

describe('deterministicTruncate', () => {
  it('returns content as-is if within limit', () => {
    const result = deterministicTruncate('Short text', 100);
    expect(result).toBe('Short text');
  });

  it('truncates long content keeping first and last portions', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i}: some content here`);
    const content = lines.join('\n');
    const result = deterministicTruncate(content, 500);

    expect(result).toContain('Line 0');
    expect(result).toContain('truncated');
    expect(result).toContain('Line 49');
    expect(result.length).toBeLessThan(content.length);
  });

  it('handles empty content', () => {
    const result = deterministicTruncate('', 100);
    expect(result).toBe('');
  });

  it('respects maxTokens as rough char limit', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i}: ${'x'.repeat(50)}`);
    const content = lines.join('\n');
    const result = deterministicTruncate(content, 50);
    // maxTokens * 4 = 200 chars max
    expect(result.length).toBeLessThanOrEqual(200);
  });
});

describe('chunkMessages', () => {
  it('chunks messages into groups of specified size', () => {
    const messages = Array.from({ length: 25 }, (_, i) => ({
      id: `msg${i}`, sessionId: 's1', ordinal: i,
      role: 'user' as const, content: `Message ${i}`, tokenCount: 3, timestamp: Date.now(),
    }));

    const chunks = chunkMessages(messages, 10);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(10);
    expect(chunks[1]).toHaveLength(10);
    expect(chunks[2]).toHaveLength(5);
  });

  it('returns single chunk for small input', () => {
    const messages = Array.from({ length: 5 }, (_, i) => ({
      id: `msg${i}`, sessionId: 's1', ordinal: i,
      role: 'user' as const, content: `Message ${i}`, tokenCount: 3, timestamp: Date.now(),
    }));

    const chunks = chunkMessages(messages, 20);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(5);
  });
});

describe('chunkArray', () => {
  it('chunks arrays correctly', () => {
    const arr = [1, 2, 3, 4, 5, 6, 7];
    expect(chunkArray(arr, 3)).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
  });

  it('handles single element', () => {
    expect(chunkArray([1], 3)).toEqual([[1]]);
  });
});

describe('buildSummaryDAG', () => {
  it('returns empty for session with no messages', async () => {
    db.ensureSession('empty-session', 'proj1');
    const result = await buildSummaryDAG('empty-session', db, {
      ollamaHost: 'http://localhost:99999', // won't be called
      generativeModel: 'test',
    });
    expect(result.leafCount).toBe(0);
    expect(result.totalNodes).toBe(0);
    expect(result.rootId).toBeNull();
  });

  it('builds DAG with deterministic fallback when Ollama is unavailable', async () => {
    db.ensureSession('s1', 'proj1');

    // Insert enough messages to create multiple chunks
    for (let i = 0; i < 45; i++) {
      db.insertMessage({
        id: `msg${i}`, sessionId: 's1', ordinal: i,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}: ${'discussion content '.repeat(5)}`,
        tokenCount: 25, timestamp: Date.now() + i,
      });
    }

    // Use non-existent Ollama → forces Level 3 (deterministic truncate)
    const result = await buildSummaryDAG('s1', db, {
      chunkSize: 20,
      targetTokens: 200,
      ollamaHost: 'http://localhost:99999',
      generativeModel: 'nonexistent',
    });

    // 45 messages / 20 per chunk = 3 leaf chunks
    expect(result.leafCount).toBe(3);
    expect(result.totalNodes).toBeGreaterThanOrEqual(3);
    expect(result.rootId).toBeDefined();

    // Verify DAG structure
    const rootSummary = db.getSummary(result.rootId!);
    expect(rootSummary).toBeDefined();
    expect(rootSummary!.kind).toBe('condensed');

    // Verify root resolves to all 45 messages
    const resolved = db.resolveSummaryToMessages(result.rootId!);
    expect(resolved).toHaveLength(45);

    // Verify session has root summary linked
    const session = db.getSession('s1');
    expect(session!.rootSummaryId).toBe(result.rootId);
  });

  it('handles single-chunk sessions (promotes to root)', async () => {
    db.ensureSession('s1', 'proj1');

    for (let i = 0; i < 5; i++) {
      db.insertMessage({
        id: `msg${i}`, sessionId: 's1', ordinal: i,
        role: 'user', content: `Short message ${i}`,
        tokenCount: 5, timestamp: Date.now() + i,
      });
    }

    const result = await buildSummaryDAG('s1', db, {
      chunkSize: 20,
      targetTokens: 200,
      ollamaHost: 'http://localhost:99999',
      generativeModel: 'nonexistent',
    });

    expect(result.leafCount).toBe(1);
    // Single leaf gets promoted to root — no condensed node needed
    expect(result.rootId).toBeDefined();
  });

  it('includes source IDs in summary content', async () => {
    db.ensureSession('s1', 'proj1');

    for (let i = 0; i < 5; i++) {
      db.insertMessage({
        id: `msg${i}`, sessionId: 's1', ordinal: i,
        role: 'user', content: `Message ${i}`,
        tokenCount: 3, timestamp: Date.now() + i,
      });
    }

    const result = await buildSummaryDAG('s1', db, {
      chunkSize: 20,
      targetTokens: 200,
      ollamaHost: 'http://localhost:99999',
      generativeModel: 'nonexistent',
    });

    const rootSummary = db.getSummary(result.rootId!);
    expect(rootSummary!.content).toContain('[sources:');
  });
});
