import { z } from 'zod';
import { Ollama } from 'ollama';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

interface LlmMapResult {
  index: number;
  status: 'ok' | 'error';
  output: string | null;
}

export function registerLlmMapTool(
  server: McpServer,
  ollamaHost: string,
  generativeModel: string,
): void {
  server.tool(
    'llm_map',
    'Process a list of items in parallel with a prompt. Engine handles iteration, concurrency, and retries. Use {{item}} as placeholder in the prompt.',
    {
      items: z.array(z.string()).describe('Items to process'),
      prompt: z.string().describe('Prompt template. {{item}} is replaced with each item.'),
      concurrency: z.number().optional().describe('Parallel workers (default: 4, max: 16)'),
      max_retries: z.number().optional().describe('Retries per item on failure (default: 1)'),
    },
    async ({ items, prompt, concurrency, max_retries }) => {
      if (items.length === 0) {
        return { content: [{ type: 'text', text: 'No items to process.' }] };
      }

      const workers = Math.min(Math.max(concurrency ?? 4, 1), 16);
      const retries = Math.min(max_retries ?? 1, 3);

      const results = await llmMap({
        items,
        prompt,
        concurrency: workers,
        maxRetries: retries,
        ollamaHost,
        model: generativeModel,
      });

      const okCount = results.filter(r => r.status === 'ok').length;
      const errCount = results.filter(r => r.status === 'error').length;

      const lines = results.map(r => {
        if (r.status === 'ok') return r.output;
        return `[ERROR] Item ${r.index} failed after ${retries + 1} attempts`;
      });

      const header = `Processed ${items.length} items: ${okCount} ok, ${errCount} errors.\n\n`;
      return { content: [{ type: 'text', text: header + lines.join('\n---\n') }] };
    },
  );
}

interface LlmMapOpts {
  items: string[];
  prompt: string;
  concurrency: number;
  maxRetries: number;
  ollamaHost: string;
  model: string;
}

async function llmMap(opts: LlmMapOpts): Promise<LlmMapResult[]> {
  const client = new Ollama({ host: opts.ollamaHost });
  const results: LlmMapResult[] = new Array(opts.items.length);

  // Simple pool: process items with limited concurrency
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < opts.items.length) {
      const idx = nextIndex++;
      const item = opts.items[idx];
      const itemPrompt = opts.prompt.replace(/\{\{item\}\}/g, item);

      let lastError = '';
      for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
        try {
          const response = await client.generate({
            model: opts.model,
            prompt: itemPrompt,
            stream: false,
          });
          results[idx] = { index: idx, status: 'ok', output: response.response.trim() };
          break;
        } catch (err: any) {
          lastError = err.message ?? 'unknown error';
          if (attempt === opts.maxRetries) {
            results[idx] = { index: idx, status: 'error', output: null };
          }
        }
      }
    }
  }

  // Spawn workers
  const workers = Array.from({ length: Math.min(opts.concurrency, opts.items.length) }, () => worker());
  await Promise.all(workers);

  return results;
}
