import { z } from 'zod';
import { KnowledgeCreateInputSchema, type KnowledgeCreateInput } from '@shared/schemas';
import type { ProductId } from '@shared/types';
import type { LocalKnowledgeStore } from './services/local-knowledge-store';
import realEstateSeed from './seeds/real_estate.json';
import kenkoKeieiSeed from './seeds/kenko_keiei.json';
import hojokinSeed from './seeds/hojokin.json';

/**
 * Per PRD §17/§18: ship vetted, legally-safe reference rebuttals so the RAG
 * grounding has content out of the box. Seeds are validated through the same
 * KnowledgeCreateInputSchema as user input, then written to the local store.
 */
const SeedFileSchema = z.array(KnowledgeCreateInputSchema);

const SEEDS: Record<ProductId, KnowledgeCreateInput[]> = {
  real_estate: SeedFileSchema.parse(realEstateSeed),
  kenko_keiei: SeedFileSchema.parse(kenkoKeieiSeed),
  hojokin: SeedFileSchema.parse(hojokinSeed),
};

export interface SeedLocalKnowledgeOptions {
  /** Restrict seeding to a single product. Default: all products. */
  productId?: ProductId | undefined;
  /** Re-create entries even if a matching trigger already exists. Default: false. */
  force?: boolean | undefined;
}

export interface SeedLocalKnowledgeResult {
  created: number;
  skipped: number;
}

export async function seedLocalKnowledge(
  store: LocalKnowledgeStore,
  opts: SeedLocalKnowledgeOptions = {},
): Promise<SeedLocalKnowledgeResult> {
  const products: ProductId[] = opts.productId
    ? [opts.productId]
    : (Object.keys(SEEDS) as ProductId[]);

  let created = 0;
  let skipped = 0;

  for (const productId of products) {
    const seeds = SEEDS[productId];
    // Dedupe by productId + trigger so re-runs are idempotent.
    const existingTriggers = new Set(
      (await store.list(productId)).map((entry) => entry.trigger),
    );

    for (const seed of seeds) {
      if (!opts.force && existingTriggers.has(seed.trigger)) {
        skipped += 1;
        continue;
      }
      await store.create(seed, { sourceType: 'builtin' });
      existingTriggers.add(seed.trigger);
      created += 1;
    }
  }

  return { created, skipped };
}
