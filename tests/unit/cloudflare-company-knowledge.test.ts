import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';

import {
  AccountLifecycleError,
  type RequestContext,
} from '../../cloudflare/src/account-lifecycle';
import {
  parseKnowledgeCandidateBatch,
  parseKnowledgeCandidateFilter,
  parseKnowledgeCandidateReview,
  reviewKnowledgeCandidate,
} from '../../cloudflare/src/company-knowledge';

const context: RequestContext = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  organizationId: '00000000-0000-4000-8000-000000000002',
  userId: '00000000-0000-4000-8000-000000000003',
  membershipId: '00000000-0000-4000-8000-000000000004',
  role: 'agency_admin',
};

describe('Cloudflare company knowledge', () => {
  it('validates one meeting-scoped candidate batch', () => {
    expect(parseKnowledgeCandidateBatch({ candidates: [candidate()] })).toMatchObject([
      {
        kind: 'summary',
        sourceCallId: '00000000-0000-4000-8000-000000000010',
        legalRisk: 'none',
      },
    ]);
    expect(() =>
      parseKnowledgeCandidateBatch({
        candidates: [
          candidate(),
          candidate({ sourceCallId: '00000000-0000-4000-8000-000000000099' }),
        ],
      }),
    ).toThrowError(new AccountLifecycleError(400, 'knowledge_candidate_source_mismatch'));
    expect(() =>
      parseKnowledgeCandidateBatch({
        candidates: [candidate({ content: '山田様へ連絡する' })],
      }),
    ).toThrowError(new AccountLifecycleError(400, 'knowledge_candidate_contains_pii'));
  });

  it('requires rejection notes and validates search filters', () => {
    expect(() => parseKnowledgeCandidateReview({ decision: 'reject' })).toThrowError(
      new AccountLifecycleError(400, 'knowledge_rejection_note_required'),
    );
    expect(parseKnowledgeCandidateReview({ decision: 'reject', reviewNote: '根拠不足' })).toEqual({
      decision: 'reject',
      reviewNote: '根拠不足',
      title: undefined,
      content: undefined,
      objectionType: undefined,
    });
    expect(
      parseKnowledgeCandidateFilter(
        new URL('https://example.test/v1/knowledge/candidates?productId=real_estate&status=pending'),
      ),
    ).toEqual({ productId: 'real_estate', status: 'pending' });
  });

  it('blocks agents before any D1 review mutation', async () => {
    await expect(
      reviewKnowledgeCandidate(
        {} as D1Database,
        { ...context, role: 'agent' },
        '00000000-0000-4000-8000-000000000005',
        { decision: 'approve' },
      ),
    ).rejects.toThrowError(new AccountLifecycleError(403, 'knowledge_manager_required'));
  });

  it('defines approval, immutable revision, outbox, and scoped indexes in migration 0009', () => {
    const migration = readFileSync(
      join(process.cwd(), 'cloudflare/migrations/0009_company_knowledge.sql'),
      'utf8',
    );
    expect(migration).toContain('CREATE TABLE knowledge_candidates');
    expect(migration).toContain('CREATE TABLE knowledge_revisions');
    expect(migration).toContain('CREATE TABLE knowledge_publish_outbox');
    expect(migration).toContain('UNIQUE(candidate_id)');
    expect(migration).toContain('tenant_id, organization_id, product_id, status');
  });
});

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '00000000-0000-4000-8000-000000000005',
    productId: 'real_estate',
    kind: 'summary',
    title: '商談サマリー',
    content: '対象範囲を分けて費用対効果を確認する',
    reasoning: '議事録から抽出',
    riskFlags: [],
    validationFlags: [],
    legalRisk: 'none',
    sourceCallId: '00000000-0000-4000-8000-000000000010',
    sourceMeetingMinuteId: '00000000-0000-4000-8000-000000000011',
    sourceTranscriptRevisionId: '00000000-0000-4000-8000-000000000012',
    sourceSegmentIds: ['00000000-0000-4000-8000-000000000013'],
    sourceEvidenceHash: 'a'.repeat(64),
    fingerprint: 'b'.repeat(64),
    ...overrides,
  };
}
