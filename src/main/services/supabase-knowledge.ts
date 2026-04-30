import { z } from 'zod';
import { ProductIdSchema } from '@shared/schemas';
import type { KnowledgeEntry } from '@shared/types';
import type { EmbeddingProvider } from './cohere';
import type { KnowledgeRepository, KnowledgeSearchInput, RankedKnowledgeCandidate } from './knowledge';
import { createSupabaseRpcClient, type SupabaseRpcClient } from './supabase';

const KnowledgeSearchRowSchema = z.object({
  id: z.string().uuid(),
  product_id: ProductIdSchema,
  objection_type: z.string(),
  trigger: z.string(),
  response: z.string(),
  reasoning: z.string().nullable(),
  risk_flags: z.array(z.string()).nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  rank: z.number().int().min(1),
});

const KnowledgeSearchRowsSchema = z.array(KnowledgeSearchRowSchema);

type KnowledgeSearchRow = z.infer<typeof KnowledgeSearchRowSchema>;

export interface SupabaseKnowledgeRepositoryOptions {
  client: SupabaseRpcClient;
  embeddingProvider: EmbeddingProvider;
  tenantId: string;
}

export class SupabaseKnowledgeRepository implements KnowledgeRepository {
  constructor(private readonly options: SupabaseKnowledgeRepositoryOptions) {}

  async searchByEmbedding(input: KnowledgeSearchInput): Promise<RankedKnowledgeCandidate[]> {
    const [queryEmbedding] = await this.options.embeddingProvider.embedTexts(
      [input.query],
      'search_query',
    );
    if (!queryEmbedding) {
      return [];
    }

    const rows = await this.rpcKnowledgeRows('match_knowledge_entries', {
      p_tenant_id: this.options.tenantId,
      p_product_id: input.productId,
      p_query_embedding: queryEmbedding,
      p_match_count: input.limit,
    });

    return rows.map(rowToCandidate);
  }

  async searchByText(input: KnowledgeSearchInput): Promise<RankedKnowledgeCandidate[]> {
    const rows = await this.rpcKnowledgeRows('search_knowledge_entries_text', {
      p_tenant_id: this.options.tenantId,
      p_product_id: input.productId,
      p_query: input.query,
      p_match_count: input.limit,
    });

    return rows.map(rowToCandidate);
  }

  private async rpcKnowledgeRows(
    functionName: string,
    args: Record<string, unknown>,
  ): Promise<KnowledgeSearchRow[]> {
    const { data, error } = await this.options.client.rpc<unknown>(functionName, args);
    if (error) {
      throw new Error(`Supabase ${functionName} failed: ${error.message}`);
    }

    return KnowledgeSearchRowsSchema.parse(data ?? []);
  }
}

export async function createSupabaseKnowledgeRepository(
  tenantId: string,
  embeddingProvider: EmbeddingProvider,
): Promise<SupabaseKnowledgeRepository> {
  return new SupabaseKnowledgeRepository({
    client: await createSupabaseRpcClient(),
    embeddingProvider,
    tenantId,
  });
}

function rowToCandidate(row: KnowledgeSearchRow): RankedKnowledgeCandidate {
  return {
    entry: rowToKnowledgeEntry(row),
    rank: row.rank,
  };
}

function rowToKnowledgeEntry(row: KnowledgeSearchRow): KnowledgeEntry {
  return {
    id: row.id,
    productId: row.product_id,
    objectionType: row.objection_type,
    trigger: row.trigger,
    response: row.response,
    reasoning: row.reasoning ?? '',
    riskFlags: row.risk_flags ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
