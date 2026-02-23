import { Ollama } from 'ollama';

export class OllamaEmbeddings {
  private client: Ollama;
  private model: string;

  constructor(config: { host: string; model: string }) {
    this.client = new Ollama({ host: config.host });
    this.model = config.model;
  }

  async generate(text: string): Promise<number[]> {
    const response = await this.client.embed({
      model: this.model,
      input: text,
    });
    return response.embeddings[0];
  }

  async generateBatch(texts: string[]): Promise<number[][]> {
    const response = await this.client.embed({
      model: this.model,
      input: texts,
    });
    return response.embeddings;
  }
}
