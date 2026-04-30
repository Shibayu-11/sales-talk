import { describe, expect, it, vi } from 'vitest';
import type { DetectedObjection, KnowledgeEntry, ObjectionResponse, Transcript } from '../../src/shared/types';
import { KnowledgeSearchService, type KnowledgeRepository } from '../../src/main/services/knowledge';
import { ObjectionLlmService, type LlmProvider } from '../../src/main/services/llm';
import {
  ObjectionPipelineService,
  shouldProcessTranscript,
} from '../../src/main/services/objection-pipeline';

const objection: DetectedObjection = {
  id: '00000000-0000-4000-8000-000000000001',
  type: 'price',
  confidence: 0.82,
  triggerText: '価格が高い',
  detectedAt: 1_777_000_000,
};

const knowledgeEntry: KnowledgeEntry = {
  id: '00000000-0000-4000-8000-000000000010',
  productId: 'real_estate',
  objectionType: 'price',
  trigger: '価格が高い',
  response: '総額で比較します',
  reasoning: '価格反論',
  riskFlags: [],
  createdAt: '2026-04-30T00:00:00Z',
  updatedAt: '2026-04-30T00:00:00Z',
};

function finalTranscript(text: string, speaker: 'self' | 'counterpart' = 'counterpart'): Transcript {
  return {
    speaker,
    text,
    isFinal: true,
    startMs: 0,
    endMs: 1_000,
  };
}

function interimTranscript(text: string): Transcript {
  return {
    speaker: 'counterpart',
    text,
    isFinal: false,
    startMs: 0,
  };
}

function createResponseProvider(): LlmProvider {
  return {
    detectObjection: vi.fn(async () => ({
      isObjection: true,
      type: objection.type,
      confidence: objection.confidence,
      triggerText: objection.triggerText,
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
        rationale: '価格反論',
        cautions: [],
        similarCases: [],
      },
      confidence: 0.8,
      riskFlags: [],
    })),
  };
}

function knowledgeService(): KnowledgeSearchService {
  const repository: KnowledgeRepository = {
    searchByEmbedding: vi.fn(async () => [{ entry: knowledgeEntry, rank: 1 }]),
    searchByText: vi.fn(async () => []),
  };
  return new KnowledgeSearchService(repository);
}

describe('shouldProcessTranscript', () => {
  it('accepts only final counterpart transcripts with enough text', () => {
    expect(shouldProcessTranscript(finalTranscript('価格が高いですね'))).toBe(true);
    expect(shouldProcessTranscript(finalTranscript('価格が高いですね', 'self'))).toBe(false);
    expect(shouldProcessTranscript(interimTranscript('価格が高いですね'))).toBe(false);
    expect(shouldProcessTranscript(finalTranscript('高い'))).toBe(false);
  });
});

describe('ObjectionPipelineService', () => {
  it('runs detection, knowledge search, response generation, and notifications', async () => {
    const provider = createResponseProvider();
    const llm = new ObjectionLlmService(provider);
    const callbacks = {
      onDetected: vi.fn(),
      onResponseReady: vi.fn(),
      onCancelled: vi.fn(),
      onError: vi.fn(),
    };
    const service = new ObjectionPipelineService({
      llm,
      knowledge: knowledgeService(),
      getProductId: () => 'real_estate',
      callbacks,
    });

    await service.handleTranscript(finalTranscript('customer@example.com が価格が高いと言っています'));

    expect(provider.detectObjection).toHaveBeenCalledWith(
      expect.objectContaining({
        utterance: '[redacted-email] が価格が高いと言っています',
      }),
    );
    expect(callbacks.onDetected).toHaveBeenCalledWith(expect.objectContaining({ type: 'price' }));
    expect(provider.generateObjectionResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: 'real_estate',
        knowledgeEntries: [expect.objectContaining({ id: knowledgeEntry.id })],
      }),
    );
    expect(callbacks.onResponseReady).toHaveBeenCalledWith(
      expect.objectContaining<Partial<ObjectionResponse>>({
        peak: '比較で整理',
        objectionId: expect.any(String) as string,
      }),
    );
    expect(callbacks.onCancelled).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it('does not notify when no product is selected', async () => {
    const provider = createResponseProvider();
    const callbacks = { onDetected: vi.fn(), onResponseReady: vi.fn() };
    const service = new ObjectionPipelineService({
      llm: new ObjectionLlmService(provider),
      knowledge: knowledgeService(),
      getProductId: () => null,
      callbacks,
    });

    await service.handleTranscript(finalTranscript('価格が高いですね'));

    expect(provider.detectObjection).not.toHaveBeenCalled();
    expect(callbacks.onDetected).not.toHaveBeenCalled();
    expect(callbacks.onResponseReady).not.toHaveBeenCalled();
  });

  it('reports errors without sending an unguarded response', async () => {
    const provider = createResponseProvider();
    vi.mocked(provider.generateObjectionResponse).mockRejectedValueOnce(new Error('llm failed'));
    const callbacks = { onDetected: vi.fn(), onResponseReady: vi.fn(), onError: vi.fn() };
    const service = new ObjectionPipelineService({
      llm: new ObjectionLlmService(provider),
      knowledge: knowledgeService(),
      getProductId: () => 'real_estate',
      callbacks,
    });

    await service.handleTranscript(finalTranscript('価格が高いですね'));

    expect(callbacks.onDetected).toHaveBeenCalled();
    expect(callbacks.onResponseReady).not.toHaveBeenCalled();
    expect(callbacks.onError).toHaveBeenCalledWith(expect.any(Error));
  });
});
