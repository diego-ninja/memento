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
}

export interface MemoryInput {
  type: MemoryType;
  content: string;
  tags: string[];
  scope?: MemoryScope;
}

export interface RecallResult {
  memory: Memory;
  score: number;
  source: 'text' | 'vector' | 'hybrid';
}

export interface RecallQuery {
  query: string;
  project?: string;
  scope?: MemoryScope;
  type?: MemoryType;
  limit?: number;
}

export interface ExtractResult {
  memories: MemoryInput[];
}

export interface MementoConfig {
  dataDir: string;
  redis: {
    host: string;
    port: number;
  };
  ollama: {
    host: string;
    model: string;
  };
  search: {
    topK: number;
    finalK: number;
    deduplicationThreshold: number;
    supersededThreshold: number;
  };
}
