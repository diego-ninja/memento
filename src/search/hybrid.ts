import type { SyncStorage } from '../storage/sync.js';
import type { OllamaEmbeddings } from '../embeddings/ollama.js';
import type { Memory, RecallQuery, RecallResult } from '../types.js';

export class HybridSearch {
  constructor(
    private storage: SyncStorage,
    private embeddings: OllamaEmbeddings,
  ) {}

  async search(query: RecallQuery): Promise<RecallResult[]> {
    const embedding = await this.embeddings.generate(query.query);
    const limit = query.limit ?? 20;

    let memories: Memory[];
    try {
      memories = await this.storage.search.hybrid(query.query, embedding, limit);
    } catch {
      memories = await this.storage.search.vector(embedding, limit);
    }

    if (memories.length === 0) {
      memories = await this.storage.search.text(query.query, limit);
    }

    return memories.map((memory, index) => ({
      memory,
      score: 1 - (index / memories.length),
      source: 'hybrid' as const,
    }));
  }
}
