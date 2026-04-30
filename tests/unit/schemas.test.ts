import { describe, expect, it } from 'vitest';
import {
  AudioChunkSchema,
  KnowledgeSearchInputSchema,
  OverlayLayerSchema,
  SecretSetInputSchema,
} from '../../src/shared/schemas';

describe('shared schemas', () => {
  it('rejects invalid overlay layers', () => {
    expect(() => OverlayLayerSchema.parse(4)).toThrow();
  });

  it('rejects empty secret values', () => {
    expect(() => SecretSetInputSchema.parse({ key: 'deepgram_api_key', value: '' })).toThrow();
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
});
