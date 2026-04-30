import { describe, expect, it, vi } from 'vitest';
import {
  CohereEmbeddingProvider,
  extractFloatEmbeddings,
  type CohereEmbedClient,
} from '../../src/main/services/cohere';

function embedding(dimensions = 1_024): number[] {
  return Array.from({ length: dimensions }, (_, index) => index / dimensions);
}

describe('CohereEmbeddingProvider', () => {
  it('masks PII before embedding texts', async () => {
    const embed = vi.fn(async () => ({ embeddings: { float: [embedding()] } }));
    const provider = new CohereEmbeddingProvider({ client: { embed } });

    await provider.embedTexts(['customer@example.com 価格が高い'], 'search_query');

    expect(embed).toHaveBeenCalledWith(
      expect.objectContaining({
        texts: ['[redacted-email] 価格が高い'],
        model: 'embed-v4.0',
        inputType: 'search_query',
        outputDimension: 1_024,
        embeddingTypes: ['float'],
        truncate: 'END',
      }),
    );
  });

  it('uses document input type for stored knowledge embeddings', async () => {
    const embed = vi.fn(async () => ({ embeddings: { float: [embedding()] } }));
    const provider = new CohereEmbeddingProvider({ client: { embed } });

    await provider.embedTexts(['導入事例'], 'search_document');

    expect(embed).toHaveBeenCalledWith(expect.objectContaining({ inputType: 'search_document' }));
  });

  it('batches requests at the Cohere text limit', async () => {
    const embed = vi.fn(async (request: Parameters<CohereEmbedClient['embed']>[0]) => ({
      embeddings: { float: request.texts.map(() => embedding()) },
    }));
    const provider = new CohereEmbeddingProvider({ client: { embed } });

    const result = await provider.embedTexts(
      Array.from({ length: 97 }, (_, index) => `text-${index}`),
      'search_query',
    );

    expect(result).toHaveLength(97);
    expect(embed).toHaveBeenCalledTimes(2);
    expect(embed.mock.calls[0]?.[0].texts).toHaveLength(96);
    expect(embed.mock.calls[1]?.[0].texts).toHaveLength(1);
  });
});

describe('extractFloatEmbeddings', () => {
  it('rejects responses without float embeddings', () => {
    expect(() => extractFloatEmbeddings({ embeddings: {} }, 1, 1_024)).toThrow(
      'Cohere response did not include float embeddings',
    );
  });

  it('rejects embedding count mismatches', () => {
    expect(() => extractFloatEmbeddings({ embeddings: { float: [] } }, 1, 1_024)).toThrow(
      'Cohere response returned 0 embeddings for 1 texts',
    );
  });

  it('rejects dimension mismatches', () => {
    expect(() => extractFloatEmbeddings({ embeddings: { float: [[0.1]] } }, 1, 1_024)).toThrow(
      'Cohere embedding dimension mismatch: expected 1024, received 1',
    );
  });
});
