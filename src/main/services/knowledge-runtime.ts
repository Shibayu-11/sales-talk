import { z } from 'zod';
import type { EmbeddingProvider } from './cohere';
import { createCohereEmbeddingProvider } from './cohere';
import {
  EmptyKnowledgeRepository,
  KnowledgeSearchService,
  type KnowledgeRepository,
  type RankedKnowledgeCandidate,
  type KnowledgeSearchInput,
} from './knowledge';
import { createSupabaseKnowledgeRepository } from './supabase-knowledge';
import { logger } from '../logger';

const TenantIdSchema = z.string().uuid();

export interface KnowledgeRuntimeEnvironment {
  SALES_TALK_TENANT_ID?: string | undefined;
}

export interface KnowledgeRuntimeOptions {
  env?: KnowledgeRuntimeEnvironment | undefined;
  createEmbeddingProvider?: (() => Promise<EmbeddingProvider>) | undefined;
  createRepository?:
    | ((tenantId: string, embeddingProvider: EmbeddingProvider) => Promise<KnowledgeRepository>)
    | undefined;
  onUnavailable?: ((reason: string, error?: unknown) => void) | undefined;
}

export function createRuntimeKnowledgeSearchService(
  options: KnowledgeRuntimeOptions = {},
): KnowledgeSearchService {
  return new KnowledgeSearchService({
    repository: createRuntimeKnowledgeRepository(options),
    onSearchError: (source, error) => {
      logger.warn({ source, error }, 'knowledge search degraded');
    },
  });
}

export function createRuntimeKnowledgeRepository(
  options: KnowledgeRuntimeOptions = {},
): KnowledgeRepository {
  const tenantId = parseTenantId(options.env ?? process.env);
  if (!tenantId) {
    options.onUnavailable?.('missing_or_invalid_tenant_id');
    return new EmptyKnowledgeRepository();
  }

  return new LazyKnowledgeRepository({
    tenantId,
    createEmbeddingProvider: options.createEmbeddingProvider ?? createCohereEmbeddingProvider,
    createRepository: options.createRepository ?? createSupabaseKnowledgeRepository,
    onUnavailable: options.onUnavailable,
  });
}

interface LazyKnowledgeRepositoryOptions {
  tenantId: string;
  createEmbeddingProvider: () => Promise<EmbeddingProvider>;
  createRepository: (
    tenantId: string,
    embeddingProvider: EmbeddingProvider,
  ) => Promise<KnowledgeRepository>;
  onUnavailable?: ((reason: string, error?: unknown) => void) | undefined;
}

class LazyKnowledgeRepository implements KnowledgeRepository {
  private repositoryPromise: Promise<KnowledgeRepository> | null = null;
  private readonly fallback = new EmptyKnowledgeRepository();

  constructor(private readonly options: LazyKnowledgeRepositoryOptions) {}

  async searchByEmbedding(input: KnowledgeSearchInput): Promise<RankedKnowledgeCandidate[]> {
    return (await this.resolveRepository()).searchByEmbedding(input);
  }

  async searchByText(input: KnowledgeSearchInput): Promise<RankedKnowledgeCandidate[]> {
    return (await this.resolveRepository()).searchByText(input);
  }

  private async resolveRepository(): Promise<KnowledgeRepository> {
    this.repositoryPromise ??= this.initializeRepository();

    try {
      return await this.repositoryPromise;
    } catch (error) {
      this.repositoryPromise = null;
      this.options.onUnavailable?.('repository_initialization_failed', error);
      return this.fallback;
    }
  }

  private async initializeRepository(): Promise<KnowledgeRepository> {
    const embeddingProvider = await this.options.createEmbeddingProvider();
    return this.options.createRepository(this.options.tenantId, embeddingProvider);
  }
}

function parseTenantId(env: KnowledgeRuntimeEnvironment): string | null {
  const tenantId = env.SALES_TALK_TENANT_ID;
  const parsed = TenantIdSchema.safeParse(tenantId);
  return parsed.success ? parsed.data : null;
}
