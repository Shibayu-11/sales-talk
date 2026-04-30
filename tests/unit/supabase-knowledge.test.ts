import { describe, expect, it, vi } from 'vitest';
import type { EmbeddingProvider } from '../../src/main/services/cohere';
import { SupabaseKnowledgeRepository } from '../../src/main/services/supabase-knowledge';
import type { SupabaseRpcClient, SupabaseRpcError } from '../../src/main/services/supabase';

const tenantId = '00000000-0000-4000-8000-000000000010';

function rpcRow(rank = 1): Record<string, unknown> {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    product_id: 'real_estate',
    objection_type: 'price',
    trigger: '価格が高い',
    response: '総額で比較します',
    reasoning: '価格反論',
    risk_flags: ['legal_reviewed'],
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-02T00:00:00Z',
    rank,
  };
}

function repository(options?: {
  rpc?: SupabaseRpcClient['rpc'] | undefined;
  embedTexts?: EmbeddingProvider['embedTexts'] | undefined;
}): SupabaseKnowledgeRepository {
  return new SupabaseKnowledgeRepository({
    client: {
      rpc: options?.rpc ?? spyRpc([rpcRow()]).rpc,
    },
    embeddingProvider: {
      embedTexts: options?.embedTexts ?? vi.fn(async () => [[0.1, 0.2]]),
    },
    tenantId,
  });
}

function spyRpc(data: unknown, error: SupabaseRpcError | null = null): {
  rpc: SupabaseRpcClient['rpc'];
  calls: Array<[string, Record<string, unknown>]>;
} {
  const calls: Array<[string, Record<string, unknown>]> = [];
  return {
    calls,
    rpc: async <T>(
      functionName: string,
      args: Record<string, unknown>,
    ): Promise<{ data: T | null; error: SupabaseRpcError | null }> => {
      calls.push([functionName, args]);
      return { data: data as T | null, error };
    },
  };
}

describe('SupabaseKnowledgeRepository', () => {
  it('embeds the query and calls vector search RPC', async () => {
    const { rpc, calls } = spyRpc([rpcRow()]);
    const embedTexts = vi.fn(async () => [[0.1, 0.2]]);
    const repo = repository({ rpc, embedTexts });

    const result = await repo.searchByEmbedding({
      query: '価格が高い',
      productId: 'real_estate',
      limit: 5,
    });

    expect(embedTexts).toHaveBeenCalledWith(['価格が高い'], 'search_query');
    expect(calls).toEqual([
      [
        'match_knowledge_entries',
        {
          p_tenant_id: tenantId,
          p_product_id: 'real_estate',
          p_query_embedding: [0.1, 0.2],
          p_match_count: 5,
        },
      ],
    ]);
    expect(result[0]).toEqual(
      expect.objectContaining({
        rank: 1,
        entry: expect.objectContaining({
          productId: 'real_estate',
          objectionType: 'price',
          riskFlags: ['legal_reviewed'],
        }),
      }),
    );
  });

  it('calls PGroonga text search RPC', async () => {
    const { rpc, calls } = spyRpc([rpcRow(2)]);
    const repo = repository({ rpc });

    const result = await repo.searchByText({
      query: '価格',
      productId: 'real_estate',
      limit: 3,
    });

    expect(calls).toEqual([
      [
        'search_knowledge_entries_text',
        {
          p_tenant_id: tenantId,
          p_product_id: 'real_estate',
          p_query: '価格',
          p_match_count: 3,
        },
      ],
    ]);
    expect(result[0]?.rank).toBe(2);
  });

  it('raises Supabase RPC errors with context', async () => {
    const repo = repository({
      rpc: spyRpc(null, { message: 'permission denied' }).rpc,
    });

    await expect(
      repo.searchByText({ query: '価格', productId: 'real_estate', limit: 3 }),
    ).rejects.toThrow('Supabase search_knowledge_entries_text failed: permission denied');
  });

  it('validates RPC row shape before mapping', async () => {
    const repo = repository({
      rpc: spyRpc([{ ...rpcRow(), rank: 0 }]).rpc,
    });

    await expect(
      repo.searchByText({ query: '価格', productId: 'real_estate', limit: 3 }),
    ).rejects.toThrow();
  });
});
