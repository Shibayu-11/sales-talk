import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalKnowledgeStore } from '../../src/main/services/local-knowledge-store';
import { seedLocalKnowledge } from '../../src/main/seed-local-knowledge';

describe('seedLocalKnowledge', () => {
  it('creates entries for all products and dedupes on re-run', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-seed-'));
    const filePath = join(directory, 'knowledge.json');

    try {
      const store = new LocalKnowledgeStore(filePath);
      const first = await seedLocalKnowledge(store);
      expect(first.created).toBeGreaterThan(0);
      expect(first.skipped).toBe(0);

      const realEstate = await store.list('real_estate');
      const kenko = await store.list('kenko_keiei');
      const hojokin = await store.list('hojokin');
      expect(realEstate.length).toBeGreaterThan(0);
      expect(kenko.length).toBeGreaterThan(0);
      expect(hojokin.length).toBeGreaterThan(0);

      // Re-run: everything already exists, so nothing new is created.
      const second = await seedLocalKnowledge(store);
      expect(second.created).toBe(0);
      expect(second.skipped).toBe(first.created);

      const afterRealEstate = await store.list('real_estate');
      expect(afterRealEstate.length).toBe(realEstate.length);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('can seed a single product', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-seed-one-'));
    const filePath = join(directory, 'knowledge.json');

    try {
      const store = new LocalKnowledgeStore(filePath);
      const result = await seedLocalKnowledge(store, { productId: 'hojokin' });
      expect(result.created).toBeGreaterThan(0);
      expect(await store.list('real_estate')).toHaveLength(0);
      expect((await store.list('hojokin')).length).toBe(result.created);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
