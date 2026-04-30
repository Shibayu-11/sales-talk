import type { KnowledgeEntry, ProductId } from '@shared/types';
import { maskPiiInText } from './pii';

export interface KnowledgeSearchInput {
  query: string;
  productId: ProductId;
  limit: number;
}

export interface KnowledgeSearchResult extends KnowledgeEntry {
  score: number;
  vectorRank?: number | undefined;
  textRank?: number | undefined;
}

export interface RankedKnowledgeCandidate {
  entry: KnowledgeEntry;
  rank: number;
}

export interface KnowledgeRepository {
  searchByEmbedding(input: KnowledgeSearchInput): Promise<RankedKnowledgeCandidate[]>;
  searchByText(input: KnowledgeSearchInput): Promise<RankedKnowledgeCandidate[]>;
}

const RRF_K = 60;

export class EmptyKnowledgeRepository implements KnowledgeRepository {
  async searchByEmbedding(): Promise<RankedKnowledgeCandidate[]> {
    return [];
  }

  async searchByText(): Promise<RankedKnowledgeCandidate[]> {
    return [];
  }
}

export type KnowledgeSearchSource = 'embedding' | 'text';

export interface KnowledgeSearchServiceOptions {
  repository?: KnowledgeRepository | undefined;
  onSearchError?: ((source: KnowledgeSearchSource, error: unknown) => void) | undefined;
}

export class KnowledgeSearchService {
  private readonly repository: KnowledgeRepository;
  private readonly onSearchError: ((source: KnowledgeSearchSource, error: unknown) => void) | undefined;

  constructor(repositoryOrOptions: KnowledgeRepository | KnowledgeSearchServiceOptions = {}) {
    if (isKnowledgeRepository(repositoryOrOptions)) {
      this.repository = repositoryOrOptions;
      return;
    }

    this.repository = repositoryOrOptions.repository ?? new EmptyKnowledgeRepository();
    this.onSearchError = repositoryOrOptions.onSearchError;
  }

  async search(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult[]> {
    const sanitizedInput = {
      ...input,
      query: maskPiiInText(input.query.trim()),
    };
    const [vectorResults, textResults] = await Promise.all([
      this.safeSearch('embedding', () => this.repository.searchByEmbedding(sanitizedInput)),
      this.safeSearch('text', () => this.repository.searchByText(sanitizedInput)),
    ]);

    return rankHybridKnowledgeResults({
      vectorResults,
      textResults,
      limit: input.limit,
    });
  }

  private async safeSearch(
    source: KnowledgeSearchSource,
    search: () => Promise<RankedKnowledgeCandidate[]>,
  ): Promise<RankedKnowledgeCandidate[]> {
    try {
      return await search();
    } catch (error) {
      this.onSearchError?.(source, error);
      return [];
    }
  }
}

export function rankHybridKnowledgeResults(input: {
  vectorResults: RankedKnowledgeCandidate[];
  textResults: RankedKnowledgeCandidate[];
  limit: number;
}): KnowledgeSearchResult[] {
  const merged = new Map<string, KnowledgeSearchResult>();

  for (const candidate of input.vectorResults) {
    const current = merged.get(candidate.entry.id);
    merged.set(candidate.entry.id, {
      ...(current ?? candidate.entry),
      score: (current?.score ?? 0) + reciprocalRank(candidate.rank),
      vectorRank: candidate.rank,
      textRank: current?.textRank,
    });
  }

  for (const candidate of input.textResults) {
    const current = merged.get(candidate.entry.id);
    merged.set(candidate.entry.id, {
      ...(current ?? candidate.entry),
      score: (current?.score ?? 0) + reciprocalRank(candidate.rank),
      vectorRank: current?.vectorRank,
      textRank: candidate.rank,
    });
  }

  return [...merged.values()]
    .sort((left, right) => right.score - left.score || left.updatedAt.localeCompare(right.updatedAt))
    .slice(0, input.limit);
}

function reciprocalRank(rank: number): number {
  return 1 / (RRF_K + rank);
}

function isKnowledgeRepository(
  value: KnowledgeRepository | KnowledgeSearchServiceOptions,
): value is KnowledgeRepository {
  return 'searchByEmbedding' in value && 'searchByText' in value;
}

export const knowledgeSearchService = new KnowledgeSearchService();
