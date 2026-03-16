import { nanoid } from 'nanoid';
import { Ollama } from 'ollama';
import type { TranscriptDb, TranscriptMessage } from './db.js';
import { estimateTokens } from './tokens.js';

export interface SummaryConfig {
  chunkSize: number;       // messages per leaf summary (~20)
  targetTokens: number;    // target tokens per summary (~300)
  ollamaHost: string;
  generativeModel: string;
}

const DEFAULT_CONFIG: SummaryConfig = {
  chunkSize: 20,
  targetTokens: 300,
  ollamaHost: 'http://127.0.0.1:11435',
  generativeModel: 'qwen2.5:3b',
};

// -- Three-Level Escalation --

export async function escalatedSummarize(
  content: string,
  targetTokens: number,
  ollamaHost: string,
  model: string,
): Promise<string> {
  const inputTokens = estimateTokens(content);

  // Level 1: Normal — preserve details
  try {
    const summary = await llmSummarize(content, 'preserve_details', targetTokens, ollamaHost, model);
    if (estimateTokens(summary) < inputTokens) return summary;
  } catch { /* fall through */ }

  // Level 2: Aggressive — bullet points
  try {
    const summary = await llmSummarize(content, 'bullet_points', Math.floor(targetTokens / 2), ollamaHost, model);
    if (estimateTokens(summary) < inputTokens) return summary;
  } catch { /* fall through */ }

  // Level 3: Deterministic truncation — no LLM
  return deterministicTruncate(content, targetTokens);
}

const PROMPTS: Record<string, string> = {
  preserve_details: `Summarize this conversation excerpt concisely. Preserve all key decisions, facts, code changes, and action items. Be telegraphic — no filler words.

Conversation:
`,
  bullet_points: `Summarize this conversation as a bullet-point list. Only include decisions, changes made, and key facts. Maximum density.

Conversation:
`,
};

async function llmSummarize(
  content: string,
  mode: string,
  maxTokens: number,
  ollamaHost: string,
  model: string,
): Promise<string> {
  const client = new Ollama({ host: ollamaHost });
  // Truncate input to ~4000 chars for small models
  const truncatedInput = content.length > 4000 ? content.slice(0, 4000) : content;
  const prompt = (PROMPTS[mode] ?? PROMPTS.preserve_details) + truncatedInput;

  const response = await client.generate({
    model,
    prompt,
    stream: false,
    options: { num_predict: maxTokens * 4 }, // chars ≈ tokens * 4
  });

  return response.response.trim();
}

export function deterministicTruncate(content: string, maxTokens: number): string {
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length === 0) return content.slice(0, maxTokens * 4);

  const keepFirst = Math.ceil(lines.length * 0.4);
  const keepLast = Math.ceil(lines.length * 0.2);
  const truncatedCount = Math.max(0, lines.length - keepFirst - keepLast);

  if (truncatedCount <= 0) {
    return lines.join('\n').slice(0, maxTokens * 4);
  }

  const result = [
    ...lines.slice(0, keepFirst),
    `[... ${truncatedCount} lines truncated ...]`,
    ...lines.slice(-keepLast),
  ].join('\n');

  return result.slice(0, maxTokens * 4);
}

// -- DAG Construction --

export function chunkMessages(messages: TranscriptMessage[], chunkSize: number): TranscriptMessage[][] {
  const chunks: TranscriptMessage[][] = [];
  for (let i = 0; i < messages.length; i += chunkSize) {
    chunks.push(messages.slice(i, i + chunkSize));
  }
  return chunks;
}

export function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function formatChunkForSummary(messages: TranscriptMessage[]): string {
  return messages
    .filter(m => m.role !== 'thinking') // skip thinking blocks for summaries
    .map(m => {
      const roleLabel = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role;
      const content = m.content.length > 500 ? m.content.slice(0, 500) + '...' : m.content;
      return `[${roleLabel}] ${content}`;
    })
    .join('\n');
}

export async function buildSummaryDAG(
  sessionId: string,
  db: TranscriptDb,
  config: Partial<SummaryConfig> = {},
): Promise<{ leafCount: number; totalNodes: number; rootId: string | null }> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const messages = db.getMessagesBySession(sessionId);

  if (messages.length === 0) {
    return { leafCount: 0, totalNodes: 0, rootId: null };
  }

  // Level 0: chunk messages into blocks, summarize each
  const chunks = chunkMessages(messages, cfg.chunkSize);
  const leafSummaries: { id: string; content: string }[] = [];

  for (const chunk of chunks) {
    const text = formatChunkForSummary(chunk);
    const summary = await escalatedSummarize(text, cfg.targetTokens, cfg.ollamaHost, cfg.generativeModel);
    const sourceIds = chunk.map(m => m.id.slice(0, 6)).join(', ');
    const contentWithSources = `${summary} [sources: ${sourceIds}]`;

    const id = nanoid();
    db.insertSummary({
      id,
      sessionId,
      kind: 'leaf',
      content: contentWithSources,
      tokenCount: estimateTokens(contentWithSources),
      level: 0,
    });
    for (const msg of chunk) {
      db.insertSummarySource(id, 'message', msg.id);
    }
    leafSummaries.push({ id, content: contentWithSources });
  }

  // Level 1+: recursively condense until 1 root
  let currentLevel = leafSummaries;
  let level = 1;
  let totalNodes = leafSummaries.length;

  while (currentLevel.length > 1) {
    const groups = chunkArray(currentLevel, 4);
    const nextLevel: { id: string; content: string }[] = [];

    for (const group of groups) {
      if (group.length === 1) {
        // No need to summarize a single node — promote it
        nextLevel.push(group[0]);
        continue;
      }

      const combined = group.map(s => s.content).join('\n---\n');
      const summary = await escalatedSummarize(combined, cfg.targetTokens, cfg.ollamaHost, cfg.generativeModel);
      const sourceIds = group.map(s => s.id.slice(0, 6)).join(', ');
      const contentWithSources = `${summary} [sources: ${sourceIds}]`;

      const id = nanoid();
      db.insertSummary({
        id,
        sessionId,
        kind: 'condensed',
        content: contentWithSources,
        tokenCount: estimateTokens(contentWithSources),
        level,
      });
      for (const child of group) {
        db.insertSummarySource(id, 'summary', child.id);
      }
      nextLevel.push({ id, content: contentWithSources });
      totalNodes++;
    }

    currentLevel = nextLevel;
    level++;
  }

  // Set root summary on session
  const rootId = currentLevel.length === 1 ? currentLevel[0].id : null;
  if (rootId) {
    db.setSessionRootSummary(sessionId, rootId);
  }

  return { leafCount: leafSummaries.length, totalNodes, rootId };
}

// -- Checkpoint (for pre-compact) --

export async function checkpoint(
  sessionId: string,
  db: TranscriptDb,
  config: Partial<SummaryConfig> = {},
): Promise<string> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const messages = db.getMessagesBySession(sessionId);

  if (messages.length === 0) {
    return 'No messages to summarize.';
  }

  // For checkpoint, build a single summary of all messages (not full DAG)
  // Use aggressive bullet points for speed
  const text = formatChunkForSummary(messages);
  const summary = await escalatedSummarize(text, 800, cfg.ollamaHost, cfg.generativeModel);

  return [
    'SESSION CHECKPOINT (Memento — what happened so far):',
    summary,
    '',
    `[${messages.length} messages in session]`,
    '',
    'Tools: transcript_grep(pattern) to search history, transcript_expand(id) to recover messages.',
    'Use remember() to persist key decisions/learnings.',
  ].join('\n');
}
