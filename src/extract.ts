import { Ollama } from 'ollama';

export interface ExtractedMemory {
  type: 'decision' | 'learning' | 'preference' | 'context' | 'fact';
  content: string;
}

const EXTRACTION_PROMPT = `Extract key memories from this session transcript.
For each memory, output ONE JSON object per line (JSONL format):
{"type":"decision|learning|preference|context|fact","content":"telegraphic note, no filler"}

Rules:
- Content must be telegraphic: no articles, no filler words, dense information
- Only extract: decisions, learnings, preferences, discovered facts
- Do NOT extract: greetings, implementation details in code, trivial conversation
- Maximum 10 memories

Transcript:
`;

export async function extractFromTranscript(
  transcript: string,
  ollamaHost: string,
  model: string,
): Promise<ExtractedMemory[]> {
  const client = new Ollama({ host: ollamaHost });

  // Truncate transcript to ~4000 chars to fit small model context
  const truncated = transcript.length > 4000
    ? transcript.slice(-4000)
    : transcript;

  const response = await client.generate({
    model,
    prompt: EXTRACTION_PROMPT + truncated,
    stream: false,
  });

  return parseExtraction(response.response);
}

export function extractWithRegex(transcript: string): ExtractedMemory[] {
  const patterns = [
    /(?:decided|chosen|we agreed|architecture)\s*[:=]?\s*(.{10,100})/gi,
    /(?:prefer|always use|never use)\s+(.{10,80})/gi,
    /(?:learned|the problem was|root cause|fixed by)\s*[:=]?\s*(.{10,100})/gi,
  ];

  const memories: ExtractedMemory[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    for (const match of transcript.matchAll(pattern)) {
      const content = match[1].trim().replace(/["\n]/g, ' ');
      if (content.length < 10 || seen.has(content)) continue;
      seen.add(content);
      memories.push({ type: 'context', content });
    }
  }

  return memories.slice(0, 10);
}

function parseExtraction(raw: string): ExtractedMemory[] {
  const memories: ExtractedMemory[] = [];
  const validTypes = new Set(['decision', 'learning', 'preference', 'context', 'fact']);

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (validTypes.has(parsed.type) && typeof parsed.content === 'string') {
        memories.push({ type: parsed.type, content: parsed.content });
      }
    } catch { /* skip malformed lines */ }
  }

  return memories;
}
