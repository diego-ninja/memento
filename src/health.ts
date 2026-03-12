import { Redis } from 'ioredis';
import type { MementoConfig } from './types.js';

export async function checkDependencies(config: MementoConfig): Promise<void> {
  // 1. Redis ping
  const redis = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    lazyConnect: true,
    connectTimeout: 3000,
    maxRetriesPerRequest: 0,
  });
  try {
    await redis.connect();
    await redis.ping();
    await redis.quit();
  } catch {
    console.error(`Memento: Redis not available at ${config.redis.host}:${config.redis.port}`);
    process.exit(1);
  }

  // 2. Ollama reachable + models
  try {
    const res = await fetch(`${config.ollama.host}/api/tags`);
    const data = await res.json() as { models: { name: string }[] };
    const models = new Set(data.models.map((m) => m.name.split(':')[0]));

    // 3. Embedding model — hard fail
    if (!models.has(config.ollama.embeddingModel.split(':')[0])) {
      console.error(`Memento: embedding model '${config.ollama.embeddingModel}' not found in Ollama`);
      process.exit(1);
    }

    // 4. Generative model — soft warning
    if (!models.has(config.ollama.generativeModel.split(':')[0])) {
      console.error(`Memento: generative model '${config.ollama.generativeModel}' not available (merge/extract will degrade)`);
    }
  } catch {
    console.error(`Memento: Ollama not available at ${config.ollama.host}`);
    process.exit(1);
  }
}
