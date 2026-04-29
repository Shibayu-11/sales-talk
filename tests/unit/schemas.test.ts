import { describe, expect, it } from 'vitest';
import {
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
});
