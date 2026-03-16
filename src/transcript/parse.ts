import type { MessageRole } from './db.js';

export interface ParsedMessage {
  role: MessageRole;
  content: string;
  timestamp: number;
  toolName?: string;
}

interface TranscriptLine {
  type: string;
  message?: {
    role: string;
    content: string | ContentBlock[];
  };
  timestamp?: string;
  [key: string]: any;
}

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: any;
  content?: string | ContentBlock[];
  tool_use_id?: string;
}

const MAX_CONTENT_LENGTH = 50_000;

function truncate(text: string): string {
  if (text.length <= MAX_CONTENT_LENGTH) return text;
  return text.slice(0, MAX_CONTENT_LENGTH) +
    `\n[... truncated ${text.length - MAX_CONTENT_LENGTH} chars ...]`;
}

function extractTextContent(content: string | ContentBlock[]): { role: MessageRole; text: string; toolName?: string } | null {
  if (typeof content === 'string') {
    return { role: 'user', text: content };
  }

  if (!Array.isArray(content) || content.length === 0) return null;

  const block = content[0];

  if (block.type === 'text' && block.text) {
    return { role: 'assistant', text: block.text };
  }

  if (block.type === 'thinking' && block.thinking) {
    return { role: 'thinking', text: block.thinking };
  }

  if (block.type === 'tool_use' && block.name) {
    const input = typeof block.input === 'string'
      ? block.input
      : JSON.stringify(block.input);
    return { role: 'tool_call', text: `${block.name}: ${input}`, toolName: block.name };
  }

  if (block.type === 'tool_result') {
    const resultContent = typeof block.content === 'string'
      ? block.content
      : Array.isArray(block.content)
        ? block.content.map((b: any) => b.text ?? '').join('\n')
        : '';
    return { role: 'tool_result', text: resultContent };
  }

  return null;
}

export function parseTranscriptLine(line: string): ParsedMessage | null {
  let parsed: TranscriptLine;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  // Skip non-message lines
  if (!parsed.message || !parsed.type) return null;
  if (parsed.type !== 'user' && parsed.type !== 'assistant') return null;

  const timestamp = parsed.timestamp
    ? new Date(parsed.timestamp).getTime()
    : Date.now();

  const extracted = extractTextContent(parsed.message.content);
  if (!extracted || !extracted.text.trim()) return null;

  return {
    role: extracted.role,
    content: truncate(extracted.text),
    timestamp,
    toolName: extracted.toolName,
  };
}

export function parseTranscript(raw: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  const seen = new Set<string>();

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const msg = parseTranscriptLine(line);
    if (!msg) continue;

    // Deduplicate: Claude Code emits multiple assistant lines for streaming
    // Use role+first-100-chars as dedup key
    const key = `${msg.role}:${msg.content.slice(0, 100)}`;
    if (msg.role === 'assistant' && seen.has(key)) continue;

    // For assistant messages, keep only the longest version (final streamed)
    // Claude Code emits partial then full text with the same prefix
    if (msg.role === 'assistant') {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.role === msg.role) {
        const shorter = lastMsg.content.length < msg.content.length ? lastMsg.content : msg.content;
        const longer = lastMsg.content.length >= msg.content.length ? lastMsg.content : msg.content;
        if (longer.startsWith(shorter.slice(0, Math.min(shorter.length, 50)))) {
          messages[messages.length - 1] = msg.content.length > lastMsg.content.length ? msg : lastMsg;
          continue;
        }
      }
    }

    seen.add(key);
    messages.push(msg);
  }

  return messages;
}
