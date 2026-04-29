import { describe, expect, it, vi } from 'vitest';
import type { KnowledgeEntry } from '../../src/shared/types';
import {
  KnowledgeSearchService,
  rankHybridKnowledgeResults,
  type KnowledgeRepository,
} from '../../src/main/services/knowledge';

function entry(id: string, updatedAt: string): KnowledgeEntry {
  return {
    id,
    productId: 'real_estate',
    objectionType: 'price',
    trigger: '価格が高い',
    response: '一般論として比較します',
    reasoning: '価格反論',
    riskFlags: [],
    createdAt: updatedAt,
    updatedAt,
  };
}

describe('rankHybridKnowledgeResults', () => {
  it('combines vector and text ranks with reciprocal rank fusion', () => {
    const a = entry('00000000-0000-4000-8000-000000000001', '2026-04-01T00:00:00Z');
    const b = entry('00000000-0000-4000-8000-000000000002', '2026-04-02T00:00:00Z');
    const c = entry('00000000-0000-4000-8000-000000000003', '2026-04-03T00:00:00Z');

    const results = rankHybridKnowledgeResults({
      vectorResults: [
        { entry: a, rank: 1 },
        { entry: b, rank: 2 },
      ],
      textResults: [
        { entry: c, rank: 1 },
        { entry: b, rank: 2 },
      ],
      limit: 3,
    });

    expect(results[0]?.id).toBe(b.id);
    expect(results[0]?.vectorRank).toBe(2);
    expect(results[0]?.textRank).toBe(2);
    expect(results).toHaveLength(3);
  });

  it('respects result limit', () => {
    const results = rankHybridKnowledgeResults({
      vectorResults: [
        { entry: entry('00000000-0000-4000-8000-000000000001', '2026-04-01T00:00:00Z'), rank: 1 },
        { entry: entry('00000000-0000-4000-8000-000000000002', '2026-04-02T00:00:00Z'), rank: 2 },
      ],
      textResults: [],
      limit: 1,
    });

    expect(results).toHaveLength(1);
  });
});

describe('KnowledgeSearchService', () => {
  it('masks PII before repository search', async () => {
    const repository: KnowledgeRepository = {
      searchByEmbedding: vi.fn(async () => []),
      searchByText: vi.fn(async () => []),
    };
    const service = new KnowledgeSearchService(repository);

    await service.search({
      query: 'customer@example.com から価格が高いと言われた',
      productId: 'real_estate',
      limit: 5,
    });

    expect(repository.searchByEmbedding).toHaveBeenCalledWith(
      expect.objectContaining({ query: '[redacted-email] から価格が高いと言われた' }),
    );
    expect(repository.searchByText).toHaveBeenCalledWith(
      expect.objectContaining({ query: '[redacted-email] から価格が高いと言われた' }),
    );
  });
});
