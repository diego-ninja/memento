import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TranscriptDb } from '../db.js';
import { ingestMessage, ingestTranscriptFile } from '../ingest.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let db: TranscriptDb;
let dbPath: string;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `memento-ingest-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = new TranscriptDb(dbPath);
});

afterEach(() => {
  db.close();
  try { fs.unlinkSync(dbPath); } catch {}
});

describe('ingestMessage', () => {
  it('creates session and inserts message', () => {
    ingestMessage(db, 'session1', 'proj1', 'user', 'Hello Claude');

    const session = db.getSession('session1');
    expect(session).toBeDefined();
    expect(session!.project).toBe('proj1');

    const messages = db.getMessagesBySession('session1');
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('Hello Claude');
    expect(messages[0].ordinal).toBe(0);
  });

  it('auto-increments ordinals', () => {
    ingestMessage(db, 'session1', 'proj1', 'user', 'First');
    ingestMessage(db, 'session1', 'proj1', 'assistant', 'Second');
    ingestMessage(db, 'session1', 'proj1', 'user', 'Third');

    const messages = db.getMessagesBySession('session1');
    expect(messages).toHaveLength(3);
    expect(messages[0].ordinal).toBe(0);
    expect(messages[1].ordinal).toBe(1);
    expect(messages[2].ordinal).toBe(2);
  });
});

describe('ingestTranscriptFile', () => {
  it('ingests a JSONL transcript file', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'What is Redis?' },
        timestamp: '2026-03-14T10:00:00.000Z',
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Redis is an in-memory data store.' }] },
        timestamp: '2026-03-14T10:00:01.000Z',
      }),
    ].join('\n');

    const tmpFile = path.join(os.tmpdir(), `transcript-test-${Date.now()}.jsonl`);
    fs.writeFileSync(tmpFile, lines);

    try {
      const result = ingestTranscriptFile(db, tmpFile, 'session1', 'proj1');
      expect(result.messages).toBe(2);
      expect(result.tokens).toBeGreaterThan(0);

      const messages = db.getMessagesBySession('session1');
      expect(messages).toHaveLength(2);

      const session = db.getSession('session1');
      expect(session!.endedAt).toBeDefined();
      expect(session!.totalMessages).toBe(2);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('returns zero for non-existent file', () => {
    const result = ingestTranscriptFile(db, '/nonexistent/file.jsonl', 's1', 'p1');
    expect(result.messages).toBe(0);
  });

  it('handles concurrent ingestion (existing + new messages)', () => {
    // Simulate real-time hooks having ingested some messages already
    ingestMessage(db, 'session1', 'proj1', 'user', 'From hook');

    // Now batch ingest the full transcript
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'From hook' },
        timestamp: '2026-03-14T10:00:00.000Z',
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Response' }] },
        timestamp: '2026-03-14T10:00:01.000Z',
      }),
    ].join('\n');

    const tmpFile = path.join(os.tmpdir(), `transcript-test2-${Date.now()}.jsonl`);
    fs.writeFileSync(tmpFile, lines);

    try {
      const result = ingestTranscriptFile(db, tmpFile, 'session1', 'proj1');
      expect(result.messages).toBe(2);

      // Should have 3 total: 1 from hook + 2 from batch
      const messages = db.getMessagesBySession('session1');
      expect(messages).toHaveLength(3);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});
