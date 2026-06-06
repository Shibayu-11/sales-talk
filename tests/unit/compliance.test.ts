import { describe, expect, it } from 'vitest';
import { evaluateCompliance } from '../../src/main/services/compliance';
import type { ComplianceRule, Transcript } from '../../src/shared/types';

describe('evaluateCompliance', () => {
  it('detects prohibited insurance expressions from final transcripts', () => {
    const rules: ComplianceRule[] = [
      {
        id: '0f0d8b25-c164-41d5-b7d7-876176de8d0f',
        tenantId: '00000000-0000-4000-8000-000000000001',
        organizationId: '00000000-0000-4000-8000-000000000002',
        companyId: 'default',
        industry: 'insurance',
        productCategory: 'insurance_general',
        severity: 'high',
        ruleType: 'prohibited_expression',
        pattern: '絶対儲かります',
        reason: '将来利益を断定する表現は顧客誤認につながります。',
        recommendedPhrase: '将来の成果は保証できないため、リスクと条件を確認します。',
        createdAt: '2026-05-25T00:00:00.000Z',
        updatedAt: '2026-05-25T00:00:00.000Z',
      },
    ];
    const transcripts: Transcript[] = [
      {
        speaker: 'counterpart',
        text: 'この商品は絶対儲かります。',
        isFinal: true,
        startMs: 100,
        endMs: 900,
      },
    ];

    expect(evaluateCompliance({ meetingId: 'meeting', transcripts, rules })).toMatchObject([
      {
        ruleId: rules[0]?.id,
        severity: 'high',
        quotedText: 'この商品は絶対儲かります。',
        reviewStatus: 'unreviewed',
      },
    ]);
  });

  it('flags missing required disclosures', () => {
    const rules: ComplianceRule[] = [
      {
        id: 'f0230688-a7f0-4377-a62a-e73f0274a3fb',
        tenantId: '00000000-0000-4000-8000-000000000001',
        organizationId: '00000000-0000-4000-8000-000000000002',
        companyId: 'default',
        industry: 'insurance',
        productCategory: 'insurance_general',
        severity: 'medium',
        ruleType: 'required_disclosure',
        pattern: '重要事項説明',
        reason: '重要事項説明の実施確認が必要です。',
        recommendedPhrase: '重要事項説明を資料に沿って実施してください。',
        createdAt: '2026-05-25T00:00:00.000Z',
        updatedAt: '2026-05-25T00:00:00.000Z',
      },
    ];

    expect(evaluateCompliance({ meetingId: 'meeting', transcripts: [], rules })).toMatchObject([
      {
        severity: 'medium',
        quotedText: '必須説明が transcript 内で確認できませんでした。',
      },
    ]);
  });
});
