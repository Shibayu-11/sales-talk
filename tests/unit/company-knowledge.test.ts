import { describe, expect, it } from 'vitest';

import {
  COMPANY_KNOWLEDGE_CANDIDATE_LIMIT,
  extractCompanyKnowledgeCandidates,
} from '../../src/main/services/company-knowledge';
import type { MeetingMinute } from '../../src/shared/types';

describe('extractCompanyKnowledgeCandidates', () => {
  it('masks PII before creating company RAG candidates', () => {
    const candidates = extractCompanyKnowledgeCandidates({
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      minute: createMeetingMinute({
        summary:
          '担当者の連絡先は yamada@example.com、090-1234-5678、4111 1111 1111 1111。導入予算は120万円。',
      }),
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.text).toContain('[redacted-email]');
    expect(candidates[0]?.text).toContain('[redacted-phone]');
    expect(candidates[0]?.text).toContain('[redacted-card]');
    expect(candidates[0]?.text).not.toContain('yamada@example.com');
    expect(candidates[0]?.text).not.toContain('090-1234-5678');
    expect(candidates[0]?.text).not.toContain('4111 1111 1111 1111');
  });

  it('normalizes text, excludes placeholders, and deduplicates by sha256 fingerprint', () => {
    const candidates = extractCompanyKnowledgeCandidates({
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      minute: createMeetingMinute({
        summary: '  来期 導入  ',
        agreed: ['来期 導入', '未定', ''],
        decisions: ['予算は300万円'],
        pending: ['予算は300万円'],
        numbers: [
          { label: '予算', value: '３００万円' },
          { label: 'なし', value: 'なし' },
        ],
      }),
    });

    expect(candidates.map((candidate) => candidate.text)).toEqual([
      '来期 導入',
      '予算は300万円',
      '予算: 300万円',
    ]);
    expect(candidates.map((candidate) => candidate.fingerprint)).toHaveLength(
      new Set(candidates.map((candidate) => candidate.fingerprint)).size,
    );
    for (const candidate of candidates) {
      expect(candidate.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('retains call, minute, revision, and product provenance', () => {
    const candidates = extractCompanyKnowledgeCandidates({
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      minute: createMeetingMinute({
        id: 'minute-2',
        callId: 'call-2',
        transcriptRevisionId: 'revision-2',
        productId: 'kenko_keiei',
        source: 'zoom_desktop',
        generatedAt: '2026-07-19T12:34:56.000Z',
        decisions: ['健康経営優良法人の申請支援を進める'],
      }),
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      kind: 'decision',
      source: {
        callId: 'call-2',
        minuteId: 'minute-2',
        transcriptRevisionId: 'revision-2',
        productId: 'kenko_keiei',
        meetingSource: 'zoom_desktop',
        minuteGeneratedAt: '2026-07-19T12:34:56.000Z',
        field: 'decision',
        itemIndex: 0,
      },
    });
  });

  it('keeps null revision provenance for legacy minutes', () => {
    const candidates = extractCompanyKnowledgeCandidates({
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      minute: createMeetingMinute({
        transcriptRevisionId: null,
        pending: ['次回までに見積条件を確認する'],
      }),
    });

    expect(candidates[0]?.source.transcriptRevisionId).toBeNull();
  });

  it('caps candidates at 25 in deterministic source order', () => {
    const candidates = extractCompanyKnowledgeCandidates({
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      minute: createMeetingMinute({
        summary: 'なし',
        agreed: Array.from({ length: 30 }, (_, index) => `合意事項${index + 1}`),
      }),
    });

    expect(candidates).toHaveLength(COMPANY_KNOWLEDGE_CANDIDATE_LIMIT);
    expect(candidates[0]?.text).toBe('合意事項1');
    expect(candidates.at(-1)?.text).toBe('合意事項25');
  });
});

function createMeetingMinute(overrides: Partial<MeetingMinute> = {}): MeetingMinute {
  return {
    id: 'minute-1',
    callId: 'call-1',
    transcriptRevisionId: 'revision-1',
    source: 'manual_transcript',
    productId: 'real_estate',
    summary: 'なし',
    agreed: [],
    pending: [],
    decisions: [],
    numbers: [],
    complianceFindings: [],
    generatedAt: '2026-07-19T00:00:00.000Z',
    ...overrides,
  };
}
