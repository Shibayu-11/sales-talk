import { describe, expect, it } from 'vitest';
import {
  AudioChunkSchema,
  CallStartInputSchema,
  CloudflareCredentialInputSchema,
  KnowledgeSearchInputSchema,
  ObjectionResponseSchema,
  OverlayLayerSchema,
  SecretSetInputSchema,
  SonnetResponseOutputSchema,
} from '../../src/shared/schemas';

const baseSonnetOutput = {
  layer1Peek: '比較で整理',
  layer2Summary: { mainResponse: '比較しましょう', keyPoints: ['総額で比較'] },
  layer3Detail: { fullScript: '一般論として比較しましょう', rationale: '有効', cautions: [], similarCases: [] },
  confidence: 0.8,
  riskFlags: [],
};

describe('shared schemas', () => {
  it('rejects invalid overlay layers', () => {
    expect(() => OverlayLayerSchema.parse(4)).toThrow();
  });

  it('rejects empty secret values', () => {
    expect(() => SecretSetInputSchema.parse({ key: 'deepgram_api_key', value: '' })).toThrow();
  });

  it('requires a strong enough Cloudflare login password', () => {
    expect(() =>
      CloudflareCredentialInputSchema.parse({
        email: 'agency-admin@example.local',
        password: 'short',
      }),
    ).toThrow();
  });

  it('normalizes knowledge search query limits', () => {
    const input = KnowledgeSearchInputSchema.parse({
      query: '  価格が高い  ',
      productId: 'real_estate',
      limit: 5,
    });

    expect(input.query).toBe('価格が高い');
    expect(input.limit).toBe(5);
  });

  it('validates audio chunks before they cross IPC boundaries', () => {
    expect(
      AudioChunkSchema.parse({
        speaker: 'counterpart',
        data: 'base64-audio',
        startMs: 0,
        durationMs: 100,
      }),
    ).toEqual({
      speaker: 'counterpart',
      data: 'base64-audio',
      startMs: 0,
      durationMs: 100,
    });

    expect(() =>
      AudioChunkSchema.parse({
        speaker: 'counterpart',
        data: '',
        startMs: -1,
        durationMs: 0,
      }),
    ).toThrow();
  });

  it('accepts Sonnet output with and without knowledgeSourceIds', () => {
    const withoutIds = SonnetResponseOutputSchema.parse(baseSonnetOutput);
    expect(withoutIds.knowledgeSourceIds).toEqual([]);

    const withIds = SonnetResponseOutputSchema.parse({
      ...baseSonnetOutput,
      knowledgeSourceIds: ['k-1', 'k-2'],
    });
    expect(withIds.knowledgeSourceIds).toEqual(['k-1', 'k-2']);
  });

  it('validates ObjectionResponse sources citations', () => {
    const parsed = ObjectionResponseSchema.parse({
      id: '00000000-0000-4000-8000-000000000001',
      objectionId: '00000000-0000-4000-8000-000000000002',
      peak: '比較で整理',
      summary: ['総額で比較'],
      fullScript: '一般論として比較しましょう',
      reasoning: '有効',
      notes: [],
      riskFlags: [],
      sources: [{ knowledgeId: 'k-1', trigger: '価格が高い', score: 0.5 }],
      generatedAtMs: 1,
    });
    expect(parsed.sources[0]?.knowledgeId).toBe('k-1');

    expect(() =>
      ObjectionResponseSchema.parse({
        id: '00000000-0000-4000-8000-000000000001',
        objectionId: '00000000-0000-4000-8000-000000000002',
        peak: 'x',
        summary: [],
        fullScript: '',
        reasoning: '',
        notes: [],
        riskFlags: [],
        generatedAtMs: 1,
      }),
    ).toThrow();
  });

  it('rejects realtime recording start without granted consent', () => {
    expect(() =>
      CallStartInputSchema.parse({
        productId: 'real_estate',
        consent: {
          status: 'pending',
          method: null,
          capturedAt: null,
          noticeVersion: 'local-v1',
        },
      }),
    ).toThrow();
  });
});
