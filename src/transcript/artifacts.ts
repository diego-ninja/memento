import { nanoid } from 'nanoid';
import type { TranscriptDb, TranscriptMessage } from './db.js';
import { estimateTokens } from './tokens.js';

export interface DetectedArtifact {
  filePath: string;
  fileType: string;
  tokenCount: number;
  content: string;
}

const FILE_TYPE_MAP: Record<string, string> = {
  ts: 'code', tsx: 'code', js: 'code', jsx: 'code',
  py: 'code', rb: 'code', go: 'code', rs: 'code',
  php: 'code', java: 'code', c: 'code', cpp: 'code',
  sh: 'code', bash: 'code', zsh: 'code',
  json: 'data', csv: 'data', xml: 'data', yaml: 'data', yml: 'data', toml: 'data',
  md: 'text', txt: 'text', rst: 'text',
  sql: 'data', graphql: 'data',
  html: 'markup', css: 'markup', scss: 'markup',
  log: 'log', env: 'config',
};

function inferFileType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return FILE_TYPE_MAP[ext] ?? 'unknown';
}

// Extract file path from tool_call content like: [Read] {"file_path":"/foo/bar.ts"}
function extractFilePathFromToolCall(content: string): string | null {
  // Pattern: [Read] {"file_path":"..."}
  const match = content.match(/\[Read\]\s*\{[^}]*"file_path"\s*:\s*"([^"]+)"/);
  if (match) return match[1];

  // Pattern: Read: {"file_path":"..."}
  const match2 = content.match(/Read:\s*\{[^}]*"file_path"\s*:\s*"([^"]+)"/);
  if (match2) return match2[1];

  return null;
}

export function detectArtifacts(messages: TranscriptMessage[], minTokens: number = 500): DetectedArtifact[] {
  const artifacts: DetectedArtifact[] = [];
  const seenPaths = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Look for tool_call with Read, then find its tool_result
    if (msg.role === 'tool_call') {
      const filePath = extractFilePathFromToolCall(msg.content);
      if (!filePath || seenPaths.has(filePath)) continue;

      // Find the next tool_result
      const nextResult = messages.slice(i + 1, i + 5).find(m => m.role === 'tool_result');
      if (!nextResult) continue;

      const tokenCount = estimateTokens(nextResult.content);
      if (tokenCount < minTokens) continue;

      seenPaths.add(filePath);
      artifacts.push({
        filePath,
        fileType: inferFileType(filePath),
        tokenCount,
        content: nextResult.content,
      });
    }
  }

  return artifacts;
}

export function storeDetectedArtifacts(
  db: TranscriptDb,
  sessionId: string,
  artifacts: DetectedArtifact[],
): number {
  let stored = 0;
  for (const a of artifacts) {
    db.upsertArtifact({
      id: nanoid(),
      sessionId,
      filePath: a.filePath,
      fileType: a.fileType,
      tokenCount: a.tokenCount,
      firstSeen: Date.now(),
    });
    stored++;
  }
  return stored;
}

// Generate type-aware exploration summary
export function generateExplorationSummary(artifact: DetectedArtifact): string {
  const preview = artifact.content.slice(0, 2000);

  switch (artifact.fileType) {
    case 'code':
      return extractCodeStructure(preview);
    case 'data':
      return extractDataShape(preview);
    default:
      return preview.slice(0, 300);
  }
}

function extractCodeStructure(content: string): string {
  const lines: string[] = [];

  // Extract imports
  const imports = content.match(/^(?:import|from|require|use)\s+.+$/gm);
  if (imports?.length) {
    lines.push(`Imports: ${imports.slice(0, 5).map(i => i.trim()).join('; ')}`);
  }

  // Extract function/class signatures
  const signatures = content.match(/^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const)\s+\w+/gm);
  if (signatures?.length) {
    lines.push(`Defines: ${signatures.map(s => s.trim()).join(', ')}`);
  }

  return lines.join('\n') || content.slice(0, 200);
}

function extractDataShape(content: string): string {
  // For JSON, try to extract top-level keys
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === 'object' && parsed !== null) {
      const keys = Object.keys(parsed).slice(0, 10);
      return `Keys: ${keys.join(', ')}${keys.length < Object.keys(parsed).length ? ` (+${Object.keys(parsed).length - keys.length} more)` : ''}`;
    }
  } catch { /* not valid JSON */ }

  // For CSV/tabular, extract header line
  const firstLine = content.split('\n')[0];
  if (firstLine?.includes(',')) {
    return `Columns: ${firstLine}`;
  }

  return content.slice(0, 200);
}
