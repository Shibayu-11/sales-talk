import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalKnowledgeStore } from '../../src/main/services/local-knowledge-store';

describe('LocalKnowledgeStore', () => {
  it('persists and searches local knowledge entries by product', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-local-knowledge-'));
    const filePath = join(directory, 'knowledge.json');

    try {
      const store = new LocalKnowledgeStore(filePath);
      await store.create({
        productId: 'real_estate',
        objectionType: 'price',
        trigger: '価格が高い',
        response: '範囲を分けて費用対効果を確認します。',
        reasoning: 'ローカル登録',
        riskFlags: [],
      });
      await store.create({
        productId: 'hojokin',
        objectionType: 'timing',
        trigger: '時期が合わない',
        response: '申請期限から逆算します。',
        reasoning: 'ローカル登録',
        riskFlags: [],
      });

      const restored = new LocalKnowledgeStore(filePath);
      expect(await restored.search('価格', 'real_estate', 5)).toHaveLength(1);
      expect(await restored.search('価格', 'hojokin', 5)).toHaveLength(0);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
