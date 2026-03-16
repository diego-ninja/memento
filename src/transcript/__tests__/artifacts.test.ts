import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TranscriptDb } from '../db.js';
import { detectArtifacts, generateExplorationSummary, storeDetectedArtifacts } from '../artifacts.js';
import type { TranscriptMessage } from '../db.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let db: TranscriptDb;
let dbPath: string;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `memento-artifacts-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = new TranscriptDb(dbPath);
});

afterEach(() => {
  db.close();
  try { fs.unlinkSync(dbPath); } catch {}
});

function makeMsg(overrides: Partial<TranscriptMessage> & { id: string; ordinal: number }): TranscriptMessage {
  return {
    sessionId: 's1',
    role: 'user',
    content: '',
    tokenCount: 10,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('detectArtifacts', () => {
  it('detects file reads from tool_call + tool_result pairs', () => {
    const messages: TranscriptMessage[] = [
      makeMsg({ id: 'msg1', ordinal: 0, role: 'tool_call', content: '[Read] {"file_path":"/src/config.ts"}' }),
      makeMsg({ id: 'msg2', ordinal: 1, role: 'tool_result', content: 'x'.repeat(3000), tokenCount: 750 }),
    ];

    const artifacts = detectArtifacts(messages, 500);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].filePath).toBe('/src/config.ts');
    expect(artifacts[0].fileType).toBe('code');
  });

  it('skips small tool results', () => {
    const messages: TranscriptMessage[] = [
      makeMsg({ id: 'msg1', ordinal: 0, role: 'tool_call', content: '[Read] {"file_path":"/small.txt"}' }),
      makeMsg({ id: 'msg2', ordinal: 1, role: 'tool_result', content: 'tiny', tokenCount: 1 }),
    ];

    const artifacts = detectArtifacts(messages, 500);
    expect(artifacts).toHaveLength(0);
  });

  it('deduplicates by file path', () => {
    const messages: TranscriptMessage[] = [
      makeMsg({ id: 'msg1', ordinal: 0, role: 'tool_call', content: '[Read] {"file_path":"/src/config.ts"}' }),
      makeMsg({ id: 'msg2', ordinal: 1, role: 'tool_result', content: 'x'.repeat(3000), tokenCount: 750 }),
      makeMsg({ id: 'msg3', ordinal: 2, role: 'tool_call', content: '[Read] {"file_path":"/src/config.ts"}' }),
      makeMsg({ id: 'msg4', ordinal: 3, role: 'tool_result', content: 'x'.repeat(3000), tokenCount: 750 }),
    ];

    const artifacts = detectArtifacts(messages, 500);
    expect(artifacts).toHaveLength(1);
  });

  it('handles Read: format (without brackets)', () => {
    const messages: TranscriptMessage[] = [
      makeMsg({ id: 'msg1', ordinal: 0, role: 'tool_call', content: 'Read: {"file_path":"/data/file.json"}' }),
      makeMsg({ id: 'msg2', ordinal: 1, role: 'tool_result', content: '{"key": "value"}'.repeat(200), tokenCount: 800 }),
    ];

    const artifacts = detectArtifacts(messages, 500);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].fileType).toBe('data');
  });
});

describe('generateExplorationSummary', () => {
  it('extracts code structure from TypeScript', () => {
    const summary = generateExplorationSummary({
      filePath: '/src/config.ts',
      fileType: 'code',
      tokenCount: 500,
      content: `import path from 'node:path';
import os from 'node:os';

export function loadConfig(): MementoConfig {
  return DEFAULT_CONFIG;
}

export class ConfigManager {
  constructor() {}
}

const DEFAULT_CONFIG = {};
`,
    });

    expect(summary).toContain('import');
    expect(summary).toContain('Defines');
  });

  it('extracts data shape from JSON', () => {
    const summary = generateExplorationSummary({
      filePath: '/data/config.json',
      fileType: 'data',
      tokenCount: 100,
      content: JSON.stringify({ name: 'memento', version: '1.0', scripts: { build: 'tsc' } }),
    });

    expect(summary).toContain('Keys');
    expect(summary).toContain('name');
  });
});

describe('storeDetectedArtifacts', () => {
  it('stores artifacts in db', () => {
    db.ensureSession('s1', 'p1');
    const artifacts = [
      { filePath: '/src/foo.ts', fileType: 'code', tokenCount: 500, content: 'code here' },
      { filePath: '/data/bar.json', fileType: 'data', tokenCount: 200, content: '{}' },
    ];

    const stored = storeDetectedArtifacts(db, 's1', artifacts);
    expect(stored).toBe(2);

    const bySession = db.getArtifactsBySession('s1');
    expect(bySession).toHaveLength(2);
  });

  it('deduplicates by path within same session', () => {
    db.ensureSession('s1', 'p1');
    const artifacts = [
      { filePath: '/src/foo.ts', fileType: 'code', tokenCount: 500, content: 'code' },
    ];

    storeDetectedArtifacts(db, 's1', artifacts);
    storeDetectedArtifacts(db, 's1', artifacts);

    const bySession = db.getArtifactsBySession('s1');
    expect(bySession).toHaveLength(1);
  });
});
