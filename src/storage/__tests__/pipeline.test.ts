import { describe, it, expect, vi } from 'vitest';
import { storeWithDedup, type StoreInput, type PipelineDeps } from '../pipeline.js';

function mockDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    storage: {
      store: vi.fn(),
      searchVector: vi.fn().mockReturnValue([]),
      mergeContent: vi.fn(),
      deleteMemory: vi.fn(),
      addEdge: vi.fn(),
      transferEdges: vi.fn(),
    } as any,
    embeddings: {
      generate: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
      generateBatch: vi.fn().mockResolvedValue([new Array(768).fill(0.1)]),
    } as any,
    config: {
      search: {
        deduplicationThreshold: 0.92,
        mergeThreshold: 0.80,
      },
      core: { promoteAfterRecalls: 3 },
    } as any,
    projectId: 'test-project',
    sessionId: 'test-session',
    ...overrides,
  };
}

describe('storeWithDedup', () => {
  it('should store new memory when no similar exists', async () => {
    const deps = mockDeps();
    const inputs: StoreInput[] = [{ type: 'decision', content: 'use SQLite for search' }];

    const result = await storeWithDedup(inputs, deps);

    expect(result.stored).toBe(1);
    expect(result.merged).toBe(0);
    expect(result.deduplicated).toBe(0);
    expect(deps.storage.store).toHaveBeenCalledOnce();
  });

  it('should skip duplicate when similarity > 0.92', async () => {
    const embedding = new Array(768).fill(0.5);
    const deps = mockDeps({
      embeddings: {
        generate: vi.fn().mockResolvedValue(embedding),
        generateBatch: vi.fn().mockResolvedValue([embedding]),
      } as any,
      storage: {
        store: vi.fn(),
        searchVector: vi.fn().mockReturnValue([{
          id: 'existing',
          content: 'use SQLite for search',
          embedding,
          type: 'decision',
          timestamp: Date.now(),
          project: 'test',
          scope: 'project',
          tags: [],
          sessionId: 'old',
          isCore: false,
          recallCount: 0,
          lastRecalled: 0,
        }]),
        mergeContent: vi.fn(),
        deleteMemory: vi.fn(),
        addEdge: vi.fn(),
        transferEdges: vi.fn(),
      } as any,
    });

    const result = await storeWithDedup(
      [{ type: 'decision', content: 'use SQLite for search' }],
      deps,
    );

    expect(result.deduplicated).toBe(1);
    expect(result.stored).toBe(0);
    expect(deps.storage.store).not.toHaveBeenCalled();
  });

  it('should batch embed multiple inputs', async () => {
    const deps = mockDeps();
    (deps.embeddings.generateBatch as any).mockResolvedValue([
      new Array(768).fill(0.1),
      new Array(768).fill(0.2),
    ]);

    const inputs: StoreInput[] = [
      { type: 'decision', content: 'first' },
      { type: 'learning', content: 'second' },
    ];

    await storeWithDedup(inputs, deps);

    expect(deps.embeddings.generateBatch).toHaveBeenCalledWith(['first', 'second']);
    expect(deps.storage.store).toHaveBeenCalledTimes(2);
  });

  it('should use single generate for single input', async () => {
    const deps = mockDeps();

    await storeWithDedup([{ type: 'decision', content: 'single' }], deps);

    expect(deps.embeddings.generate).toHaveBeenCalledWith('single');
    expect(deps.embeddings.generateBatch).not.toHaveBeenCalled();
  });
});
