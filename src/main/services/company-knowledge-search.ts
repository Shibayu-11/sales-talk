import type { KnowledgeEntry } from '@shared/types';

import { logger } from '../logger';
import { searchCloudflareKnowledge } from './cloudflare-api';
import {
  KnowledgeSearchService,
  type KnowledgeRepository,
  type KnowledgeSearchInput,
  type RankedKnowledgeCandidate,
} from './knowledge';
import { appRepositories } from './repositories';

export function createCompanyScopedKnowledgeSearchService(): KnowledgeSearchService {
  return new KnowledgeSearchService(new CompanyScopedKnowledgeRepository());
}

class CompanyScopedKnowledgeRepository implements KnowledgeRepository {
  async searchByEmbedding(): Promise<RankedKnowledgeCandidate[]> {
    return [];
  }

  async searchByText(input: KnowledgeSearchInput): Promise<RankedKnowledgeCandidate[]> {
    const context = await appRepositories.organizations.assertPermission('calls:read');
    const localEntries = await appRepositories.knowledge.search(
      input.query,
      input.productId,
      input.limit,
      { tenantId: context.tenant.id, organizationId: context.organization.id },
    );
    const cloudEntries = await searchCloudflareKnowledge(input).catch((error: unknown) => {
      logger.warn({ error }, 'company knowledge cloud search degraded');
      return [];
    });
    return dedupeKnowledgeEntries([...localEntries, ...cloudEntries])
      .slice(0, input.limit)
      .map((entry, index) => ({ entry, rank: index + 1 }));
  }
}

function dedupeKnowledgeEntries(entries: KnowledgeEntry[]): KnowledgeEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = entry.fingerprint ?? entry.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
