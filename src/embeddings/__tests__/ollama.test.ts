import { describe, it, expect } from 'vitest';
import { OllamaEmbeddings } from '../ollama.js';

describe('OllamaEmbeddings', () => {
  const embeddings = new OllamaEmbeddings({
    host: 'http://127.0.0.1:11435',
    model: 'nomic-embed-text',
  });

  it('generates an embedding for a text', async () => {
    const result = await embeddings.generate('Redis is fast for search');

    expect(result).toBeInstanceOf(Array);
    expect(result.length).toBe(768);
    expect(typeof result[0]).toBe('number');
  });

  it('generates different embeddings for different texts', async () => {
    const a = await embeddings.generate('Redis is a database');
    const b = await embeddings.generate('TypeScript is a language');

    const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
    const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
    const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
    const similarity = dot / (normA * normB);

    expect(similarity).toBeLessThan(0.95);
  });
});
