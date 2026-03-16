import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TranscriptDb } from '../transcript/db.js';

export function registerTranscriptDescribeTool(
  server: McpServer,
  db: TranscriptDb,
): void {
  server.tool(
    'transcript_describe',
    'Get metadata for a session, summary, artifact, or message. Shows artifacts, session neighbors, and summaries without expanding full content.',
    {
      id: z.string().describe('Session ID, summary ID, artifact ID, message ID, or file path'),
    },
    async ({ id }) => {
      // Try session
      const session = db.getSession(id);
      if (session) {
        const date = new Date(session.startedAt).toISOString().slice(0, 16);
        const endDate = session.endedAt ? new Date(session.endedAt).toISOString().slice(0, 16) : 'ongoing';
        const rootSummary = session.rootSummaryId ? db.getSummary(session.rootSummaryId) : null;
        const artifacts = db.getArtifactsBySession(id);
        const neighbors = db.getSessionNeighbors(id);

        const lines = [
          `Session: ${session.id}`,
          `Project: ${session.project}`,
          `Period: ${date} → ${endDate}`,
          `Messages: ${session.totalMessages}`,
          `Tokens: ${session.totalTokens}`,
        ];
        if (rootSummary) {
          lines.push(`Summary: ${rootSummary.content.slice(0, 200)}`);
        }
        if (artifacts.length > 0) {
          lines.push(`\nArtifacts (${artifacts.length}):`);
          for (const a of artifacts.slice(0, 10)) {
            lines.push(`  [${a.fileType ?? '?'}] ${a.filePath} (${a.tokenCount ?? '?'} tokens)`);
          }
        }
        if (neighbors.length > 0) {
          lines.push(`\nLinked sessions:`);
          for (const n of neighbors) {
            const arrow = n.direction === 'next' ? '→' : '←';
            lines.push(`  ${arrow} ${n.sessionId.slice(0, 8)} (${n.relationship}, ${(n.strength * 100).toFixed(0)}%)`);
          }
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      // Try summary
      const summary = db.getSummary(id);
      if (summary) {
        const sources = db.getSummarySources(id);
        const lines = [
          `Summary: ${id}`,
          `Kind: ${summary.kind} (level ${summary.level})`,
          `Session: ${summary.sessionId.slice(0, 8)}`,
          `Tokens: ${summary.tokenCount}`,
          `Sources: ${sources.length} ${sources[0]?.sourceType ?? 'items'}s`,
          `Content: ${summary.content.slice(0, 300)}`,
        ];
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      // Try artifact by ID
      const artifact = db.getArtifact(id);
      if (artifact) {
        return { content: [{ type: 'text', text: formatArtifact(artifact) }] };
      }

      // Try artifact by file path
      const artifactByPath = db.getArtifactByPath(id);
      if (artifactByPath) {
        return { content: [{ type: 'text', text: formatArtifact(artifactByPath) }] };
      }

      // Try message
      const msg = db.getMessage(id);
      if (msg) {
        const lines = [
          `Message: ${id}`,
          `Session: ${msg.sessionId.slice(0, 8)}`,
          `Ordinal: #${msg.ordinal}`,
          `Role: ${msg.role}`,
          `Tokens: ${msg.tokenCount}`,
          `Time: ${new Date(msg.timestamp).toISOString().slice(0, 16)}`,
          `Preview: ${msg.content.slice(0, 200)}`,
        ];
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      return { content: [{ type: 'text', text: `ID "${id}" not found.` }] };
    },
  );
}

function formatArtifact(a: { id: string; sessionId: string; filePath: string; fileType: string | null; tokenCount: number | null; explorationSummary: string | null }): string {
  const lines = [
    `Artifact: ${a.id}`,
    `Path: ${a.filePath}`,
    `Type: ${a.fileType ?? 'unknown'}`,
    `Tokens: ${a.tokenCount ?? 'unknown'}`,
    `Session: ${a.sessionId.slice(0, 8)}`,
  ];
  if (a.explorationSummary) {
    lines.push(`Exploration: ${a.explorationSummary}`);
  }
  return lines.join('\n');
}
