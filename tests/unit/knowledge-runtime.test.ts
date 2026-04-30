import { describe, expect, it, vi } from 'vitest';
import type { EmbeddingProvider } from '../../src/main/services/cohere';
import {
  createRuntimeKnowledgeRepository,
  createRuntimeKnowledgeSearchService,
} from '../../src/main/services/knowledge-runtime';
import type {
  KnowledgeRepository,
  KnowledgeSearchInput,
  RankedKnowledgeCandidate,
} from '../../src/main/services/knowledge';

const tenantId = '00000000-0000-4000-8000-000000000010';

const searchInput: KnowledgeSearchInput = {
  query: '価格',
  productId: 'real_estate',
  limit: 5,
};

function repository(results: RankedKnowledgeCandidate[] = []): KnowledgeRepository {
  return {
    searchByEmbedding: vi.fn(async () => results),
    searchByText: vi.fn(async () => results),
  };
}

describe('createRuntimeKnowledgeRepository', () => {
  it('uses an empty repository when tenant id is missing', async () => {
    const onUnavailable = vi.fn();
    const repo = createRuntimeKnowledgeRepository({
      env: {},
      onUnavailable,
      createEmbeddingProvider: vi.fn(async () => ({ embedTexts: vi.fn() })),
      createRepository: vi.fn(async () => repository()),
    });

    await expect(repo.searchByText(searchInput)).resolves.toEqual([]);
    expect(onUnavailable).toHaveBeenCalledWith('missing_or_invalid_tenant_id');
  });

  it('lazily creates the Supabase-backed repository once', async () => {
    const embeddingProvider: EmbeddingProvider = { embedTexts: vi.fn(async () => [[0.1]]) };
    const createEmbeddingProvider = vi.fn(async () => embeddingProvider);
    const createdRepository = repository();
    const createRepository = vi.fn(async () => createdRepository);
    const repo = createRuntimeKnowledgeRepository({
      env: { SALES_TALK_TENANT_ID: tenantId },
      createEmbeddingProvider,
      createRepository,
    });

    await repo.searchByText(searchInput);
    await repo.searchByEmbedding(searchInput);

    expect(createEmbeddingProvider).toHaveBeenCalledTimes(1);
    expect(createRepository).toHaveBeenCalledWith(tenantId, embeddingProvider);
    expect(createRepository).toHaveBeenCalledTimes(1);
  });

  it('falls back to empty results and retries after initialization failure', async () => {
    const onUnavailable = vi.fn();
    const createEmbeddingProvider = vi
      .fn<() => Promise<EmbeddingProvider>>()
      .mockRejectedValueOnce(new Error('missing key'))
      .mockResolvedValueOnce({ embedTexts: vi.fn(async () => [[0.1]]) });
    const createRepository = vi.fn(async () => repository());
    const repo = createRuntimeKnowledgeRepository({
      env: { SALES_TALK_TENANT_ID: tenantId },
      createEmbeddingProvider,
      createRepository,
      onUnavailable,
    });

    await expect(repo.searchByText(searchInput)).resolves.toEqual([]);
    await repo.searchByText(searchInput);

    expect(onUnavailable).toHaveBeenCalledWith(
      'repository_initialization_failed',
      expect.any(Error),
    );
    expect(createEmbeddingProvider).toHaveBeenCalledTimes(2);
    expect(createRepository).toHaveBeenCalledTimes(1);
  });
});

describe('createRuntimeKnowledgeSearchService', () => {
  it('returns empty search results when runtime repository is unavailable', async () => {
    const service = createRuntimeKnowledgeSearchService({ env: {} });

    await expect(service.search(searchInput)).resolves.toEqual([]);
  });
});
