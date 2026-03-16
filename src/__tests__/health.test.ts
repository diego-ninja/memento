import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkDependencies } from '../health.js';

describe('checkDependencies', () => {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit called');
  }) as any);
  const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  beforeEach(() => {
    exitSpy.mockClear();
    stderrSpy.mockClear();
  });

  it('should fail with clear message when Ollama is unreachable', async () => {
    const config = {
      ollama: { host: 'http://127.0.0.1:19998', embeddingModel: 'nomic-embed-text', generativeModel: 'qwen2.5:3b' },
    };

    await expect(checkDependencies(config as any)).rejects.toThrow('process.exit called');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Ollama not available'));
  });
});
