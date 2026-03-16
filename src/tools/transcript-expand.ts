import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TranscriptDb, TranscriptMessage } from '../transcript/db.js';

export function registerTranscriptExpandTool(
  server: McpServer,
  db: TranscriptDb,
): void {
  server.tool(
    'transcript_expand',
    'Expand a summary into its original messages, or view messages around a position in a session. Lossless context recovery.',
    {
      id: z.string().describe('Summary ID, message ID, or session ID (or prefix)'),
      around: z.number().optional().describe('Message ordinal to center on (default: 0, returns +-10 messages)'),
      limit: z.number().optional().describe('Number of messages to return (default: 20)'),
    },
    async ({ id, around, limit }) => {
      const window = limit ?? 20;

      // 1. Try as summary
      const summary = db.getSummary(id);
      if (summary) {
        const messages = db.resolveSummaryToMessages(id);
        if (messages.length === 0) {
          return { content: [{ type: 'text', text: `Summary ${id} has no resolved messages.` }] };
        }
        const header = `Expanded summary (${summary.kind}, level ${summary.level}): "${summary.content.slice(0, 80)}..."`;
        return { content: [{ type: 'text', text: `${header}\n\n${formatMessages(messages)}` }] };
      }

      // 2. Try as session (exact or prefix)
      const session = db.getSession(id) ?? findSessionByPrefix(db, id);
      if (session) {
        const messages = db.getMessagesAround(session.id, around ?? 0, window);
        if (messages.length === 0) {
          return { content: [{ type: 'text', text: `Session ${id} has no messages.` }] };
        }
        const date = new Date(session.startedAt).toISOString().slice(0, 10);
        const header = `Session ${session.id.slice(0, 8)} (${date}), messages ${messages[0].ordinal}-${messages[messages.length - 1].ordinal}:`;
        return { content: [{ type: 'text', text: `${header}\n\n${formatMessages(messages)}` }] };
      }

      // 3. Try as message ID
      const msg = db.getMessage(id);
      if (msg) {
        const context = db.getMessagesAround(msg.sessionId, msg.ordinal, window);
        const header = `Context around message #${msg.ordinal} in session ${msg.sessionId.slice(0, 8)}:`;
        return { content: [{ type: 'text', text: `${header}\n\n${formatMessages(context)}` }] };
      }

      return { content: [{ type: 'text', text: `ID "${id}" not found. Try transcript_grep to find what you're looking for.` }] };
    },
  );
}

function findSessionByPrefix(db: TranscriptDb, prefix: string): ReturnType<TranscriptDb['getSession']> {
  // getRecentSessions with high limit, find by prefix
  // This is a simple approach — for many sessions, add a dedicated query
  const sessions = db.getRecentSessions('', 100);
  return sessions.find(s => s.id.startsWith(prefix));
}

function formatMessages(messages: TranscriptMessage[]): string {
  return messages.map(m => {
    const roleLabel = ROLE_LABELS[m.role] ?? m.role;
    const content = m.content.length > 500
      ? m.content.slice(0, 500) + `\n[... ${m.content.length - 500} chars truncated ...]`
      : m.content;
    return `#${m.ordinal} [${roleLabel}]\n${content}`;
  }).join('\n\n---\n\n');
}

const ROLE_LABELS: Record<string, string> = {
  user: 'User',
  assistant: 'Assistant',
  tool_call: 'Tool Call',
  tool_result: 'Tool Result',
  thinking: 'Thinking',
};
