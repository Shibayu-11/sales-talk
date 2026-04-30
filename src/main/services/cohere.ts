import { CohereClientV2 } from 'cohere-ai';
import {
  COHERE_EMBED_DIMENSIONS,
  COHERE_EMBED_MODEL,
  COHERE_MAX_TEXTS_PER_REQUEST,
} from '@shared/constants';
import { maskPiiInText } from './pii';
import { secretStore } from './secrets';

export type EmbeddingInputType = 'search_query' | 'search_document';

export interface EmbeddingProvider {
  embedTexts(texts: string[], inputType: EmbeddingInputType): Promise<number[][]>;
}

interface CohereEmbedRequest {
  texts: string[];
  model: string;
  inputType: EmbeddingInputType;
  outputDimension: number;
  embeddingTypes: ['float'];
  truncate: 'END';
}

interface CohereEmbedResponse {
  embeddings: {
    float?: number[][] | undefined;
  };
}

export interface CohereEmbedClient {
  embed(request: CohereEmbedRequest): Promise<CohereEmbedResponse>;
}

export interface CohereEmbeddingProviderOptions {
  client: CohereEmbedClient;
  model?: string | undefined;
  dimensions?: number | undefined;
  maxTextsPerRequest?: number | undefined;
}

export class CohereEmbeddingProvider implements EmbeddingProvider {
  private readonly model: string;
  private readonly dimensions: number;
  private readonly maxTextsPerRequest: number;

  constructor(private readonly options: CohereEmbeddingProviderOptions) {
    this.model = options.model ?? process.env.COHERE_EMBED_MODEL ?? COHERE_EMBED_MODEL;
    this.dimensions = options.dimensions ?? COHERE_EMBED_DIMENSIONS;
    this.maxTextsPerRequest = options.maxTextsPerRequest ?? COHERE_MAX_TEXTS_PER_REQUEST;
  }

  async embedTexts(texts: string[], inputType: EmbeddingInputType): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const embeddings: number[][] = [];
    const sanitizedTexts = texts.map((text) => maskPiiInText(text));

    for (const batch of chunkArray(sanitizedTexts, this.maxTextsPerRequest)) {
      const response = await this.options.client.embed({
        texts: batch,
        model: this.model,
        inputType,
        outputDimension: this.dimensions,
        embeddingTypes: ['float'],
        truncate: 'END',
      });

      embeddings.push(...extractFloatEmbeddings(response, batch.length, this.dimensions));
    }

    return embeddings;
  }
}

export async function createCohereEmbeddingProvider(): Promise<CohereEmbeddingProvider> {
  const apiKey = await secretStore.get('cohere_api_key');
  if (!apiKey) {
    throw new Error('Cohere API key is not configured');
  }

  return new CohereEmbeddingProvider({
    client: new CohereClientV2({ token: apiKey, timeoutInSeconds: 5, maxRetries: 1 }),
  });
}

export function extractFloatEmbeddings(
  response: CohereEmbedResponse,
  expectedCount: number,
  expectedDimensions: number,
): number[][] {
  const floatEmbeddings = response.embeddings.float;
  if (!floatEmbeddings) {
    throw new Error('Cohere response did not include float embeddings');
  }

  if (floatEmbeddings.length !== expectedCount) {
    throw new Error(
      `Cohere response returned ${floatEmbeddings.length} embeddings for ${expectedCount} texts`,
    );
  }

  for (const embedding of floatEmbeddings) {
    if (embedding.length !== expectedDimensions) {
      throw new Error(
        `Cohere embedding dimension mismatch: expected ${expectedDimensions}, received ${embedding.length}`,
      );
    }
  }

  return floatEmbeddings;
}

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}
