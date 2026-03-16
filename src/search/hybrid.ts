import type { SyncStorage } from '../storage/sync.js';
import type { OllamaEmbeddings } from '../embeddings/ollama.js';
import type { Memory, RecallQuery, RecallResult } from '../types.js';

export class HybridSearch {
  constructor(
    private storage: SyncStorage,
    private embeddings: OllamaEmbeddings,
    private rrfK: number = 60,
  ) {}

  async search(query: RecallQuery): Promise<RecallResult[]> {
    const embedding = await this.embeddings.generate(query.query);
    const limit = query.limit ?? 20;

    const [textResults, vectorResults] = await Promise.all([
      this.storage.search.text(query.query, limit).catch(() => [] as Memory[]),
      this.storage.search.vector(embedding, limit).catch(() => [] as Memory[]),
    ]);

    return rrfFuse(textResults, vectorResults, this.rrfK);
  }
}

export function rrfFuse(
  textResults: Memory[],
  vectorResults: Memory[],
  k: number,
): RecallResult[] {
  const scores = new Map<string, { memory: Memory; score: number }>();

  for (let i = 0; i < textResults.length; i++) {
    const mem = textResults[i];
    const existing = scores.get(mem.id);
    const rrfScore = 1 / (k + i + 1);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scores.set(mem.id, { memory: mem, score: rrfScore });
    }
  }

  for (let i = 0; i < vectorResults.length; i++) {
    const mem = vectorResults[i];
    const existing = scores.get(mem.id);
    const rrfScore = 1 / (k + i + 1);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scores.set(mem.id, { memory: mem, score: rrfScore });
    }
  }

  const results: RecallResult[] = Array.from(scores.values()).map(({ memory, score }) => ({
    memory,
    score,
    source: 'rrf' as const,
  }));

  results.sort((a, b) => b.score - a.score);
  return results;
}
