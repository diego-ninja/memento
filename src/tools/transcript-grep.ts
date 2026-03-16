import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TranscriptDb, TranscriptMessage } from '../transcript/db.js';

interface GrepMatch extends TranscriptMessage {
  sessionStartedAt: number;
}

export function registerTranscriptGrepTool(
  server: McpServer,
  db: TranscriptDb,
): void {
  server.tool(
    'transcript_grep',
    'Regex search across all past session transcripts. Returns matches grouped by session with surrounding context. Use this to find anything discussed in previous sessions.',
    {
      pattern: z.string().describe('Search pattern (substring match)'),
      session_id: z.string().optional().describe('Limit search to a specific session ID'),
      role: z.enum(['user', 'assistant', 'tool_call', 'tool_result', 'thinking']).optional().describe('Filter by message role'),
      limit: z.number().optional().describe('Max results (default: 20)'),
    },
    async ({ pattern, session_id, role, limit }) => {
      const results = db.grepMessages(pattern, {
        sessionId: session_id,
        role: role as any,
        limit: limit ?? 20,
      });

      if (results.length === 0) {
        return { content: [{ type: 'text', text: `No matches for "${pattern}".` }] };
      }

      const output = formatGrepResults(results, pattern);
      return { content: [{ type: 'text', text: output }] };
    },
  );
}

function formatGrepResults(results: GrepMatch[], pattern: string): string {
  // Group by session
  const bySession = new Map<string, GrepMatch[]>();
  for (const r of results) {
    const list = bySession.get(r.sessionId) ?? [];
    list.push(r);
    bySession.set(r.sessionId, list);
  }

  const sections: string[] = [];

  for (const [sessionId, matches] of bySession) {
    const date = new Date(matches[0].sessionStartedAt).toISOString().slice(0, 10);
    const shortId = sessionId.slice(0, 8);

    const lines = matches.map(m => {
      const roleChar = ROLE_CHAR[m.role] ?? '?';
      const snippet = highlightMatch(m.content, pattern);
      return `  #${m.ordinal} [${roleChar}] ${snippet}`;
    });

    sections.push(`[${shortId} — ${date}]\n${lines.join('\n')}`);
  }

  return sections.join('\n\n');
}

const ROLE_CHAR: Record<string, string> = {
  user: 'U',
  assistant: 'A',
  tool_call: 'T>',
  tool_result: 'T<',
  thinking: '...',
};

function highlightMatch(content: string, pattern: string): string {
  // Find the match position and extract context around it
  const lowerContent = content.toLowerCase();
  const lowerPattern = pattern.toLowerCase();
  const idx = lowerContent.indexOf(lowerPattern);

  if (idx === -1) {
    // Fallback: just truncate
    return truncateLine(content);
  }

  const contextChars = 60;
  const start = Math.max(0, idx - contextChars);
  const end = Math.min(content.length, idx + pattern.length + contextChars);

  let snippet = '';
  if (start > 0) snippet += '...';
  snippet += content.slice(start, idx);
  snippet += `>>>${content.slice(idx, idx + pattern.length)}<<<`;
  snippet += content.slice(idx + pattern.length, end);
  if (end < content.length) snippet += '...';

  return snippet.replace(/\n/g, ' ');
}

function truncateLine(content: string): string {
  const oneLine = content.replace(/\n/g, ' ');
  if (oneLine.length <= 120) return oneLine;
  return oneLine.slice(0, 120) + '...';
}
