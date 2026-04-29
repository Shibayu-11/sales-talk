import { describe, expect, it, vi } from 'vitest';
import type { DetectedObjection, KnowledgeEntry } from '../../src/shared/types';
import { ObjectionLlmService, type LlmProvider } from '../../src/main/services/llm';

const objection: DetectedObjection = {
  id: '00000000-0000-4000-8000-000000000001',
  type: 'price',
  confidence: 0.82,
  triggerText: '山田さんは価格が高いと言っています',
  detectedAt: 1_777_000_000,
};

const knowledgeEntry: KnowledgeEntry = {
  id: '00000000-0000-4000-8000-000000000010',
  productId: 'real_estate',
  objectionType: 'price',
  trigger: 'customer@example.com が価格懸念',
  response: '一般論として比較します',
  reasoning: '090-1234-5678 に連絡しない',
  riskFlags: [],
  createdAt: '2026-04-30T00:00:00Z',
  updatedAt: '2026-04-30T00:00:00Z',
};

function createProvider(): LlmProvider {
  return {
    detectObjection: vi.fn(async () => ({
      isObjection: true,
      type: 'price',
      confidence: 0.82,
      triggerText: 'customer@example.com が高いと言った',
      reasoning: '価格懸念',
    })),
    generateObjectionResponse: vi.fn(async () => ({
      layer1Peek: '比較で整理',
      layer2Summary: {
        mainResponse: '条件を揃えて比較しましょう。',
        keyPoints: ['総額で比較', '条件を揃える', '次に確認'],
      },
      layer3Detail: {
        fullScript: '一般論として、条件を揃えて比較しましょう。',
        rationale: '価格反論に有効',
        cautions: [],
        similarCases: [],
      },
      confidence: 0.8,
      riskFlags: [],
    })),
  };
}

describe('ObjectionLlmService.detect', () => {
  it('masks PII before detection and returns thresholded objections', async () => {
    const provider = createProvider();
    const service = new ObjectionLlmService(provider);

    const result = await service.detect({
      productId: 'real_estate',
      utterance: 'customer@example.com が価格が高いと言っています',
      recentContext: '電話は090-1234-5678です',
    });

    expect(provider.detectObjection).toHaveBeenCalledWith({
      productId: 'real_estate',
      utterance: '[redacted-email] が価格が高いと言っています',
      recentContext: '電話は[redacted-phone]です',
    });
    expect(result?.type).toBe('price');
    expect(result?.triggerText).toBe('[redacted-email] が高いと言った');
  });

  it('returns null below confidence threshold', async () => {
    const provider = createProvider();
    vi.mocked(provider.detectObjection).mockResolvedValueOnce({
      isObjection: true,
      type: 'price',
      confidence: 0.69,
      triggerText: '高い',
      reasoning: '弱い',
    });
    const service = new ObjectionLlmService(provider);

    await expect(
      service.detect({ productId: 'real_estate', utterance: '高い', recentContext: '' }),
    ).resolves.toBeNull();
  });
});

describe('ObjectionLlmService.generateResponse', () => {
  it('masks dynamic input before generation and returns validated response', async () => {
    const provider = createProvider();
    const service = new ObjectionLlmService(provider);

    const result = await service.generateResponse({
      productId: 'real_estate',
      objection,
      transcript: 'customer@example.com が価格を懸念',
      knowledgeEntries: [knowledgeEntry],
    });

    expect(provider.generateObjectionResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        transcript: '[redacted-email] が価格を懸念',
        knowledgeEntries: [
          expect.objectContaining({
            trigger: '[redacted-email] が価格懸念',
            reasoning: '[redacted-phone] に連絡しない',
          }),
        ],
      }),
    );
    expect(result.peak).toBe('比較で整理');
    expect(result.fullScript).toBe('一般論として、条件を揃えて比較しましょう。');
  });

  it('replaces unsafe generated text before returning to UI', async () => {
    const provider = createProvider();
    vi.mocked(provider.generateObjectionResponse).mockResolvedValueOnce({
      layer1Peek: '利回り保証',
      layer2Summary: {
        mainResponse: '利回りは必ず保証できます。',
        keyPoints: ['保証できます'],
      },
      layer3Detail: {
        fullScript: '利回りは必ず保証できます。',
        rationale: '危険',
        cautions: [],
        similarCases: [],
      },
      confidence: 0.9,
      riskFlags: [],
    });
    const service = new ObjectionLlmService(provider);

    const result = await service.generateResponse({
      productId: 'real_estate',
      objection,
      transcript: '価格懸念',
      knowledgeEntries: [],
    });

    expect(result.peak).toBe('専門家確認');
    expect(result.fullScript).toContain('一般論として');
    expect(result.fullScript).not.toContain('保証できます');
    expect(result.riskFlags).toContain('real_estate_yield_guarantee');
    expect(result.riskFlags).toContain('requires_human_review');
  });
});
