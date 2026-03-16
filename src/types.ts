export type MemoryType = 'decision' | 'learning' | 'preference' | 'context' | 'fact';
export type MemoryScope = 'global' | 'project';

export interface Memory {
  id: string;
  timestamp: number;
  project: string;
  scope: MemoryScope;
  type: MemoryType;
  content: string;
  tags: string[];
  embedding: number[];
  sessionId: string;
  supersedes?: string;
  isCore: boolean;
  recallCount: number;
  lastRecalled: number;
}

export interface MemoryInput {
  type: MemoryType;
  content: string;
  core?: boolean;
}

export interface RecallResult {
  memory: Memory;
  score: number;
  source: 'text' | 'vector' | 'rrf';
}

export interface RecallQuery {
  query: string;
  project?: string;
  scope?: MemoryScope;
  type?: MemoryType;
  limit?: number;
}

export interface MementoConfig {
  dataDir: string;
  ollama: {
    host: string;
    embeddingModel: string;
    generativeModel: string;
  };
  search: {
    topK: number;
    finalK: number;
    deduplicationThreshold: number;
    mergeThreshold: number;
    rrfK: number;
  };
  core: {
    promoteAfterRecalls: number;
    degradeAfterSessions: number;
  };
  extraction: {
    provider: 'ollama' | 'anthropic';
    ollama: { model: string };
    anthropic: { model: string };
  };
}
