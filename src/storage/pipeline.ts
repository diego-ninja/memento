import { nanoid } from 'nanoid';
import type { SyncStorage } from './sync.js';
import type { SqliteStorage } from './sqlite.js';
import type { OllamaEmbeddings } from '../embeddings/ollama.js';
import type { MementoConfig, Memory, MemoryType } from '../types.js';

export interface StoreInput {
  type: MemoryType;
  content: string;
  core?: boolean;
}

export interface StoreResult {
  stored: number;
  merged: number;
  deduplicated: number;
}

export interface PipelineDeps {
  storage: SyncStorage;
  sqlite: SqliteStorage;
  embeddings: OllamaEmbeddings;
  config: MementoConfig;
  projectId: string;
  sessionId: string;
  mergeWithLLM?: (old: string, new_: string) => Promise<string>;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export async function storeWithDedup(
  inputs: StoreInput[],
  deps: PipelineDeps,
): Promise<StoreResult> {
  const { storage, sqlite, embeddings, config, projectId, sessionId, mergeWithLLM } = deps;

  let stored = 0;
  let merged = 0;
  let deduplicated = 0;

  // 1. Batch generate embeddings
  const contents = inputs.map(m => m.content);
  const allEmbeddings = inputs.length === 1
    ? [await embeddings.generate(contents[0])]
    : await embeddings.generateBatch(contents);

  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const embedding = allEmbeddings[i];

    // 2. Vector search top-10 for dedup + edge building
    const existing = await storage.search.vector(embedding, 10);

    let bestMatch: { memory: Memory; similarity: number } | undefined;

    if (existing.length > 0) {
      for (const candidate of existing) {
        const candidateEmb = candidate.embedding.length > 0
          ? candidate.embedding
          : await embeddings.generate(candidate.content);
        const sim = cosineSimilarity(embedding, candidateEmb);

        if (!bestMatch || sim > bestMatch.similarity) {
          bestMatch = { memory: candidate, similarity: sim };
        }
      }
    }

    if (bestMatch) {
      // 3. Similarity > 0.92 → deduplicate
      if (bestMatch.similarity > config.search.deduplicationThreshold) {
        deduplicated++;
        continue;
      }

      // 4. Similarity 0.80-0.92 → store + edge + background merge
      if (bestMatch.similarity > config.search.mergeThreshold) {
        const newMemory = createMemory(input, embedding, projectId, sessionId);
        await storage.store(newMemory);
        sqlite.addEdge(newMemory.id, bestMatch.memory.id, bestMatch.similarity);

        // Fire-and-forget background merge
        if (mergeWithLLM) {
          backgroundMerge(bestMatch.memory, newMemory, storage, sqlite, embeddings, mergeWithLLM);
        }

        stored++;
        buildEdgesSync(newMemory.id, embedding, existing, bestMatch.memory.id, sqlite, config);
        continue;
      }

      // 5. Similarity 0.70-0.80 → store + edge (related but distinct)
      if (bestMatch.similarity > 0.70) {
        const newMemory = createMemory(input, embedding, projectId, sessionId);
        await storage.store(newMemory);
        sqlite.addEdge(newMemory.id, bestMatch.memory.id, bestMatch.similarity);
        stored++;
        buildEdgesSync(newMemory.id, embedding, existing, bestMatch.memory.id, sqlite, config);
        continue;
      }
    }

    // 6. No match or similarity < 0.70 → store new
    const newMemory = createMemory(input, embedding, projectId, sessionId);
    await storage.store(newMemory);
    stored++;

    if (existing.length > 0) {
      buildEdgesSync(newMemory.id, embedding, existing, undefined, sqlite, config);
    }
  }

  return { stored, merged, deduplicated };
}

function createMemory(
  input: StoreInput,
  embedding: number[],
  projectId: string,
  sessionId: string,
): Memory {
  return {
    id: nanoid(),
    timestamp: Date.now(),
    project: projectId,
    scope: 'project',
    type: input.type,
    content: input.content,
    tags: [],
    embedding,
    sessionId,
    isCore: input.core ?? false,
    recallCount: 0,
    lastRecalled: 0,
  };
}

function buildEdgesSync(
  newId: string,
  newEmbedding: number[],
  candidates: Memory[],
  alreadyLinked: string | undefined,
  sqlite: SqliteStorage,
  config: MementoConfig,
): void {
  for (const candidate of candidates) {
    if (candidate.id === alreadyLinked) continue;
    if (candidate.embedding.length === 0) continue;

    const sim = cosineSimilarity(newEmbedding, candidate.embedding);
    if (sim > 0.70 && sim < config.search.deduplicationThreshold) {
      sqlite.addEdge(newId, candidate.id, sim);
    }
  }
}

function backgroundMerge(
  oldMemory: Memory,
  newMemory: Memory,
  storage: SyncStorage,
  sqlite: SqliteStorage,
  embeddings: OllamaEmbeddings,
  mergeWithLLM: (old: string, new_: string) => Promise<string>,
): void {
  Promise.resolve().then(async () => {
    const mergedContent = await mergeWithLLM(oldMemory.content, newMemory.content);
    const mergedEmbedding = await embeddings.generate(mergedContent);
    await storage.mergeMemory(newMemory.id, mergedContent, mergedEmbedding);
    sqlite.transferEdges(oldMemory.id, newMemory.id);
    await storage.deleteMemory(oldMemory.id);
  }).catch(console.error);
}
