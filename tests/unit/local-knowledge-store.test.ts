import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LocalKnowledgeStore,
  type KnowledgeCandidateDraft,
} from '../../src/main/services/local-knowledge-store';

const scope = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  organizationId: '00000000-0000-4000-8000-000000000002',
};

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

  it('keeps meeting knowledge private until a manager approves it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-local-knowledge-review-'));
    const filePath = join(directory, 'knowledge.json');

    try {
      const store = new LocalKnowledgeStore(filePath);
      const [candidate] = await store.saveCandidates([candidateDraft()]);
      expect(candidate?.status).toBe('pending');
      expect(await store.search('費用対効果', 'real_estate', 5, scope)).toEqual([]);

      await store.reviewCandidate(scope, {
        id: candidate?.id ?? '',
        decision: 'approve',
        reviewerUserId: '00000000-0000-4000-8000-000000000006',
        objectionType: 'price',
      });

      await expect(store.search('費用対効果', 'real_estate', 5, scope)).resolves.toMatchObject([
        {
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          sourceType: 'meeting',
          status: 'approved',
        },
      ]);
      await expect(
        store.search('費用対効果', 'real_estate', 5, {
          tenantId: scope.tenantId,
          organizationId: '00000000-0000-4000-8000-000000000099',
        }),
      ).resolves.toEqual([]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('supersedes stale candidates and blocks unsafe approval', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-local-knowledge-revision-'));
    const filePath = join(directory, 'knowledge.json');

    try {
      const store = new LocalKnowledgeStore(filePath);
      const [first] = await store.saveCandidates([candidateDraft()]);
      const [second] = await store.saveCandidates([
        candidateDraft({
          sourceMeetingMinuteId: '00000000-0000-4000-8000-000000000020',
          sourceTranscriptRevisionId: '00000000-0000-4000-8000-000000000021',
          fingerprint: 'b'.repeat(64),
          legalRisk: 'blocked',
        }),
      ]);

      const candidates = await store.listCandidates(scope);
      expect(candidates.find((candidate) => candidate.id === first?.id)?.status).toBe('superseded');
      await expect(
        store.reviewCandidate(scope, {
          id: second?.id ?? '',
          decision: 'approve',
          reviewerUserId: '00000000-0000-4000-8000-000000000006',
        }),
      ).rejects.toThrow('Blocked knowledge candidate cannot be approved');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

function candidateDraft(
  overrides: Partial<KnowledgeCandidateDraft> = {},
): KnowledgeCandidateDraft {
  return {
    ...scope,
    productId: 'real_estate',
    kind: 'summary',
    title: '価格懸念への対応',
    content: '対象範囲を分けて費用対効果を確認する',
    reasoning: '商談議事録から抽出',
    riskFlags: [],
    validationFlags: [],
    legalRisk: 'none',
    sourceCallId: '00000000-0000-4000-8000-000000000010',
    sourceMeetingMinuteId: '00000000-0000-4000-8000-000000000011',
    sourceTranscriptRevisionId: '00000000-0000-4000-8000-000000000012',
    sourceSegmentIds: ['00000000-0000-4000-8000-000000000013'],
    sourceEvidenceHash: 'a'.repeat(64),
    fingerprint: 'a'.repeat(64),
    ...overrides,
  };
}
