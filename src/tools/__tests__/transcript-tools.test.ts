import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TranscriptDb } from '../../transcript/db.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let db: TranscriptDb;
let dbPath: string;

function seedTestData() {
  db.ensureSession('session-abc', 'proj1');
  db.insertMessage({ id: 'msg1', sessionId: 'session-abc', ordinal: 0, role: 'user', content: 'How do I configure Redis for vector search?', tokenCount: 10, timestamp: Date.now() - 5000 });
  db.insertMessage({ id: 'msg2', sessionId: 'session-abc', ordinal: 1, role: 'assistant', content: 'You need Redis Stack with the RediSearch module. Use docker-compose to set it up.', tokenCount: 15, timestamp: Date.now() - 4000 });
  db.insertMessage({ id: 'msg3', sessionId: 'session-abc', ordinal: 2, role: 'tool_call', content: '[Read] {"file_path":"/docker-compose.yml"}', tokenCount: 8, timestamp: Date.now() - 3000 });
  db.insertMessage({ id: 'msg4', sessionId: 'session-abc', ordinal: 3, role: 'tool_result', content: 'services:\n  redis:\n    image: redis/redis-stack-server:latest\n    ports:\n      - "6380:6379"', tokenCount: 12, timestamp: Date.now() - 2000 });
  db.insertMessage({ id: 'msg5', sessionId: 'session-abc', ordinal: 4, role: 'assistant', content: 'The docker-compose.yml already has Redis Stack configured on port 6380.', tokenCount: 13, timestamp: Date.now() - 1000 });

  db.ensureSession('session-def', 'proj1');
  db.insertMessage({ id: 'msg6', sessionId: 'session-def', ordinal: 0, role: 'user', content: 'What about SQLite for persistence?', tokenCount: 7, timestamp: Date.now() });
  db.insertMessage({ id: 'msg7', sessionId: 'session-def', ordinal: 1, role: 'assistant', content: 'SQLite with WAL mode is ideal for single-writer scenarios. Use better-sqlite3 for synchronous access.', tokenCount: 16, timestamp: Date.now() });

  // Add summaries
  db.insertSummary({ id: 'sum-leaf1', sessionId: 'session-abc', kind: 'leaf', content: 'Discussed Redis Stack setup with docker-compose on port 6380', tokenCount: 10, level: 0 });
  db.insertSummarySource('sum-leaf1', 'message', 'msg1');
  db.insertSummarySource('sum-leaf1', 'message', 'msg2');

  db.insertSummary({ id: 'sum-leaf2', sessionId: 'session-abc', kind: 'leaf', content: 'Verified docker-compose.yml has correct Redis configuration', tokenCount: 8, level: 0 });
  db.insertSummarySource('sum-leaf2', 'message', 'msg3');
  db.insertSummarySource('sum-leaf2', 'message', 'msg4');
  db.insertSummarySource('sum-leaf2', 'message', 'msg5');

  db.insertSummary({ id: 'sum-root', sessionId: 'session-abc', kind: 'condensed', content: 'Set up Redis Stack for vector search using docker-compose', tokenCount: 9, level: 1 });
  db.insertSummarySource('sum-root', 'summary', 'sum-leaf1');
  db.insertSummarySource('sum-root', 'summary', 'sum-leaf2');

  db.setSessionRootSummary('session-abc', 'sum-root');
}

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `memento-tools-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = new TranscriptDb(dbPath);
  seedTestData();
});

afterEach(() => {
  db.close();
  try { fs.unlinkSync(dbPath); } catch {}
});

describe('grep functionality', () => {
  it('finds messages by substring', () => {
    const results = db.grepMessages('Redis', {});
    expect(results.length).toBeGreaterThanOrEqual(3);
  });

  it('finds messages filtered by role', () => {
    const results = db.grepMessages('Redis', { role: 'user' });
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('configure Redis');
  });

  it('finds messages filtered by session', () => {
    const results = db.grepMessages('Redis', { sessionId: 'session-abc' });
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it('returns empty for no matches', () => {
    const results = db.grepMessages('nonexistent_pattern_xyz', {});
    expect(results).toHaveLength(0);
  });

  it('respects limit', () => {
    const results = db.grepMessages('Redis', { limit: 1 });
    expect(results).toHaveLength(1);
  });
});

describe('expand functionality', () => {
  it('resolves a leaf summary to its messages', () => {
    const messages = db.resolveSummaryToMessages('sum-leaf1');
    expect(messages).toHaveLength(2);
    expect(messages.map(m => m.id)).toContain('msg1');
    expect(messages.map(m => m.id)).toContain('msg2');
  });

  it('resolves a root summary recursively to all leaf messages', () => {
    const messages = db.resolveSummaryToMessages('sum-root');
    expect(messages).toHaveLength(5);
  });

  it('gets messages around a position', () => {
    const messages = db.getMessagesAround('session-abc', 2, 4);
    expect(messages.length).toBeGreaterThanOrEqual(3);
    expect(messages.some(m => m.ordinal === 2)).toBe(true);
  });
});

describe('describe functionality', () => {
  it('describes a session', () => {
    const session = db.getSession('session-abc');
    expect(session).toBeDefined();
    expect(session!.rootSummaryId).toBe('sum-root');
  });

  it('describes a summary with sources', () => {
    const summary = db.getSummary('sum-root');
    expect(summary).toBeDefined();
    expect(summary!.kind).toBe('condensed');
    expect(summary!.level).toBe(1);

    const sources = db.getSummarySources('sum-root');
    expect(sources).toHaveLength(2);
    expect(sources[0].sourceType).toBe('summary');
  });

  it('gets root summary text for a session', () => {
    const text = db.getRootSummary('session-abc');
    expect(text).toContain('Redis Stack');
  });
});

describe('sessions listing', () => {
  it('lists recent sessions for a project', () => {
    const sessions = db.getRecentSessions('proj1', 10);
    expect(sessions).toHaveLength(2);
  });

  it('shows root summary when available', () => {
    const sessions = db.getRecentSessions('proj1', 10);
    const withSummary = sessions.find(s => s.rootSummaryId);
    expect(withSummary).toBeDefined();
  });
});
