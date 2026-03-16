import fs from 'node:fs';
import { nanoid } from 'nanoid';
import type { TranscriptDb, MessageRole } from './db.js';
import { parseTranscript } from './parse.js';
import { estimateTokens } from './tokens.js';

export interface IngestResult {
  messages: number;
  tokens: number;
}

// Ingest a single message (used by real-time hooks)
export function ingestMessage(
  db: TranscriptDb,
  sessionId: string,
  projectId: string,
  role: MessageRole,
  content: string,
): void {
  db.ensureSession(sessionId, projectId);
  const ordinal = db.getNextOrdinal(sessionId);
  const tokenCount = estimateTokens(content);

  db.insertMessage({
    id: nanoid(),
    sessionId,
    ordinal,
    role,
    content,
    tokenCount,
    timestamp: Date.now(),
  });
}

// Batch ingest a full transcript file (used by session-end hook)
export function ingestTranscriptFile(
  db: TranscriptDb,
  transcriptPath: string,
  sessionId: string,
  projectId: string,
): IngestResult {
  if (!fs.existsSync(transcriptPath)) {
    return { messages: 0, tokens: 0 };
  }

  const raw = fs.readFileSync(transcriptPath, 'utf-8');
  const parsed = parseTranscript(raw);

  if (parsed.length === 0) {
    return { messages: 0, tokens: 0 };
  }

  let totalTokens = 0;
  const existingCount = db.getMessageCount(sessionId);

  db.transaction(() => {
    db.ensureSession(sessionId, projectId);

    for (let i = 0; i < parsed.length; i++) {
      const msg = parsed[i];
      const tokenCount = estimateTokens(msg.content);
      totalTokens += tokenCount;

      db.insertMessage({
        id: nanoid(),
        sessionId,
        ordinal: existingCount + i,
        role: msg.role,
        content: msg.content,
        tokenCount,
        timestamp: msg.timestamp,
      });
    }

    db.endSession(sessionId);
  });

  return { messages: parsed.length, tokens: totalTokens };
}
