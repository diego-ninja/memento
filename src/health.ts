import type { MementoConfig } from './types.js';

export async function checkDependencies(config: MementoConfig): Promise<void> {
  // Ollama reachable + models
  try {
    const res = await fetch(`${config.ollama.host}/api/tags`);
    const data = await res.json() as { models: { name: string }[] };
    const models = new Set(data.models.map((m) => m.name.split(':')[0]));

    if (!models.has(config.ollama.embeddingModel.split(':')[0])) {
      console.error(`Memento: embedding model '${config.ollama.embeddingModel}' not found in Ollama`);
      process.exit(1);
    }

    if (!models.has(config.ollama.generativeModel.split(':')[0])) {
      console.error(`Memento: generative model '${config.ollama.generativeModel}' not available (merge/extract will degrade)`);
    }
  } catch {
    console.error(`Memento: Ollama not available at ${config.ollama.host}`);
    process.exit(1);
  }
}
