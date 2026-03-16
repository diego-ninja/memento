import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TranscriptDb } from '../db.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let db: TranscriptDb;
let dbPath: string;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `memento-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = new TranscriptDb(dbPath);
});

afterEach(() => {
  db.close();
  try { fs.unlinkSync(dbPath); } catch {}
});

describe('TranscriptDb', () => {
  describe('sessions', () => {
    it('creates and retrieves a session', () => {
      db.ensureSession('s1', 'proj1');
      const session = db.getSession('s1');
      expect(session).toBeDefined();
      expect(session!.project).toBe('proj1');
    });

    it('ensureSession is idempotent', () => {
      db.ensureSession('s1', 'proj1');
      db.ensureSession('s1', 'proj1');
      const session = db.getSession('s1');
      expect(session).toBeDefined();
    });

    it('gets recent sessions ordered by start time', () => {
      db.ensureSession('s1', 'proj1');
      db.ensureSession('s2', 'proj1');
      db.ensureSession('s3', 'proj1');
      const recent = db.getRecentSessions('proj1', 2);
      expect(recent).toHaveLength(2);
    });
  });

  describe('messages', () => {
    it('inserts and retrieves messages', () => {
      db.ensureSession('s1', 'proj1');
      db.insertMessage({
        id: 'msg1', sessionId: 's1', ordinal: 0,
        role: 'user', content: 'Hello', tokenCount: 1, timestamp: Date.now(),
      });
      db.insertMessage({
        id: 'msg2', sessionId: 's1', ordinal: 1,
        role: 'assistant', content: 'Hi there', tokenCount: 2, timestamp: Date.now(),
      });

      const messages = db.getMessagesBySession('s1');
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe('user');
      expect(messages[1].role).toBe('assistant');
    });

    it('auto-increments ordinal via getNextOrdinal', () => {
      db.ensureSession('s1', 'proj1');
      expect(db.getNextOrdinal('s1')).toBe(0);

      db.insertMessage({
        id: 'msg1', sessionId: 's1', ordinal: 0,
        role: 'user', content: 'Hello', tokenCount: 1, timestamp: Date.now(),
      });
      expect(db.getNextOrdinal('s1')).toBe(1);
    });

    it('ignores duplicate inserts (OR IGNORE)', () => {
      db.ensureSession('s1', 'proj1');
      db.insertMessage({
        id: 'msg1', sessionId: 's1', ordinal: 0,
        role: 'user', content: 'Hello', tokenCount: 1, timestamp: Date.now(),
      });
      // Same id, should not throw
      db.insertMessage({
        id: 'msg1', sessionId: 's1', ordinal: 0,
        role: 'user', content: 'Different', tokenCount: 1, timestamp: Date.now(),
      });
      const messages = db.getMessagesBySession('s1');
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Hello'); // original preserved
    });

    it('getMessagesAround returns windowed results', () => {
      db.ensureSession('s1', 'proj1');
      for (let i = 0; i < 20; i++) {
        db.insertMessage({
          id: `msg${i}`, sessionId: 's1', ordinal: i,
          role: 'user', content: `Message ${i}`, tokenCount: 3, timestamp: Date.now(),
        });
      }

      const around = db.getMessagesAround('s1', 10, 6);
      expect(around).toHaveLength(7); // ordinals 7-13
      expect(around[0].ordinal).toBe(7);
    });
  });

  describe('grep', () => {
    it('finds messages matching pattern', () => {
      db.ensureSession('s1', 'proj1');
      db.insertMessage({
        id: 'msg1', sessionId: 's1', ordinal: 0,
        role: 'user', content: 'How to configure Redis?', tokenCount: 5, timestamp: Date.now(),
      });
      db.insertMessage({
        id: 'msg2', sessionId: 's1', ordinal: 1,
        role: 'assistant', content: 'Use docker compose for Redis', tokenCount: 6, timestamp: Date.now(),
      });
      db.insertMessage({
        id: 'msg3', sessionId: 's1', ordinal: 2,
        role: 'user', content: 'What about SQLite?', tokenCount: 4, timestamp: Date.now(),
      });

      const results = db.grepMessages('Redis', {});
      expect(results).toHaveLength(2);
    });

    it('filters by role', () => {
      db.ensureSession('s1', 'proj1');
      db.insertMessage({
        id: 'msg1', sessionId: 's1', ordinal: 0,
        role: 'user', content: 'Redis question', tokenCount: 3, timestamp: Date.now(),
      });
      db.insertMessage({
        id: 'msg2', sessionId: 's1', ordinal: 1,
        role: 'assistant', content: 'Redis answer', tokenCount: 3, timestamp: Date.now(),
      });

      const results = db.grepMessages('Redis', { role: 'user' });
      expect(results).toHaveLength(1);
      expect(results[0].role).toBe('user');
    });

    it('filters by session', () => {
      db.ensureSession('s1', 'proj1');
      db.ensureSession('s2', 'proj1');
      db.insertMessage({
        id: 'msg1', sessionId: 's1', ordinal: 0,
        role: 'user', content: 'Redis in s1', tokenCount: 3, timestamp: Date.now(),
      });
      db.insertMessage({
        id: 'msg2', sessionId: 's2', ordinal: 0,
        role: 'user', content: 'Redis in s2', tokenCount: 3, timestamp: Date.now(),
      });

      const results = db.grepMessages('Redis', { sessionId: 's1' });
      expect(results).toHaveLength(1);
      expect(results[0].sessionId).toBe('s1');
    });
  });

  describe('summaries', () => {
    it('creates summaries and resolves to messages', () => {
      db.ensureSession('s1', 'proj1');
      db.insertMessage({
        id: 'msg1', sessionId: 's1', ordinal: 0,
        role: 'user', content: 'Hello', tokenCount: 1, timestamp: Date.now(),
      });
      db.insertMessage({
        id: 'msg2', sessionId: 's1', ordinal: 1,
        role: 'assistant', content: 'Hi', tokenCount: 1, timestamp: Date.now(),
      });

      db.insertSummary({
        id: 'sum1', sessionId: 's1', kind: 'leaf',
        content: 'Greeting exchange', tokenCount: 3, level: 0,
      });
      db.insertSummarySource('sum1', 'message', 'msg1');
      db.insertSummarySource('sum1', 'message', 'msg2');

      const resolved = db.resolveSummaryToMessages('sum1');
      expect(resolved).toHaveLength(2);
    });

    it('resolves condensed summaries recursively', () => {
      db.ensureSession('s1', 'proj1');
      db.insertMessage({ id: 'msg1', sessionId: 's1', ordinal: 0, role: 'user', content: 'A', tokenCount: 1, timestamp: Date.now() });
      db.insertMessage({ id: 'msg2', sessionId: 's1', ordinal: 1, role: 'user', content: 'B', tokenCount: 1, timestamp: Date.now() });

      db.insertSummary({ id: 'leaf1', sessionId: 's1', kind: 'leaf', content: 'Leaf 1', tokenCount: 2, level: 0 });
      db.insertSummarySource('leaf1', 'message', 'msg1');

      db.insertSummary({ id: 'leaf2', sessionId: 's1', kind: 'leaf', content: 'Leaf 2', tokenCount: 2, level: 0 });
      db.insertSummarySource('leaf2', 'message', 'msg2');

      db.insertSummary({ id: 'root', sessionId: 's1', kind: 'condensed', content: 'Root', tokenCount: 1, level: 1 });
      db.insertSummarySource('root', 'summary', 'leaf1');
      db.insertSummarySource('root', 'summary', 'leaf2');

      const resolved = db.resolveSummaryToMessages('root');
      expect(resolved).toHaveLength(2);
      expect(resolved.map(m => m.content)).toContain('A');
      expect(resolved.map(m => m.content)).toContain('B');
    });
  });

  describe('endSession', () => {
    it('updates session stats', () => {
      db.ensureSession('s1', 'proj1');
      db.insertMessage({ id: 'msg1', sessionId: 's1', ordinal: 0, role: 'user', content: 'Hello world', tokenCount: 3, timestamp: Date.now() });
      db.insertMessage({ id: 'msg2', sessionId: 's1', ordinal: 1, role: 'assistant', content: 'Hi', tokenCount: 1, timestamp: Date.now() });

      db.endSession('s1');

      const session = db.getSession('s1');
      expect(session!.totalMessages).toBe(2);
      expect(session!.totalTokens).toBe(4);
      expect(session!.endedAt).toBeDefined();
    });
  });
});
