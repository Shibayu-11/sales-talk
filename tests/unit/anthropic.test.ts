import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@anthropic-ai/sdk/resources/messages';
import {
  AnthropicLlmProvider,
  parseJsonFromMessage,
  runAnthropicDiagnostic,
} from '../../src/main/services/anthropic';

function message(text: string): Message {
  return {
    id: 'msg_test',
    content: [{ type: 'text', text }],
    model: 'claude-test',
    role: 'assistant',
    stop_reason: 'end_turn',
    stop_sequence: null,
    type: 'message',
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

describe('parseJsonFromMessage', () => {
  it('parses plain JSON text', () => {
    expect(parseJsonFromMessage(message('{"ok":true}'))).toEqual({ ok: true });
  });

  it('parses fenced JSON text', () => {
    expect(parseJsonFromMessage(message('```json\n{"ok":true}\n```'))).toEqual({ ok: true });
  });

  it('parses fenced JSON text with surrounding assistant text', () => {
    expect(parseJsonFromMessage(message('```json\n{"ok":true}\n```\n'))).toEqual({ ok: true });
  });

  it('parses JSON text with an opening fence only', () => {
    expect(parseJsonFromMessage(message('```json\n{"ok":true}'))).toEqual({ ok: true });
  });

  it('rejects empty text responses', () => {
    expect(() => parseJsonFromMessage({ ...message(''), content: [] })).toThrow(
      'Anthropic response did not include text content',
    );
  });
});

describe('AnthropicLlmProvider', () => {
  it('calls Haiku model for detection with JSON prompt', async () => {
    const create = vi.fn(async () =>
      message(
        JSON.stringify({
          isObjection: true,
          type: 'price',
          confidence: 0.8,
          triggerText: '高い',
          reasoning: '価格懸念',
        }),
      ),
    );
    const provider = new AnthropicLlmProvider({
      client: { messages: { create } },
      haikuModel: 'haiku-test',
      sonnetModel: 'sonnet-test',
    });

    const result = await provider.detectObjection({
      productId: 'real_estate',
      utterance: '高い',
      recentContext: '前後文脈',
    });

    expect(result).toEqual(expect.objectContaining({ type: 'price' }));
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'haiku-test',
        max_tokens: 300,
        temperature: 0,
        messages: [expect.objectContaining({ role: 'user' })],
      }),
    );
  });

  it('calls Sonnet model for response generation', async () => {
    const create = vi.fn(async () =>
      message(
        JSON.stringify({
          layer1Peek: '比較で整理',
          layer2Summary: { mainResponse: '比較しましょう', keyPoints: ['総額で比較'] },
          layer3Detail: {
            fullScript: '一般論として比較しましょう',
            rationale: '有効',
            cautions: [],
            similarCases: [],
          },
          confidence: 0.8,
          riskFlags: [],
        }),
      ),
    );
    const provider = new AnthropicLlmProvider({
      client: { messages: { create } },
      haikuModel: 'haiku-test',
      sonnetModel: 'sonnet-test',
    });

    await provider.generateObjectionResponse({
      productId: 'real_estate',
      objection: {
        id: '00000000-0000-4000-8000-000000000001',
        type: 'price',
        confidence: 0.8,
        triggerText: '高い',
        detectedAt: 1,
      },
      transcript: '高い',
      knowledgeEntries: [],
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'sonnet-test',
        max_tokens: 2_000,
        temperature: 0.2,
      }),
    );
  });
});

describe('runAnthropicDiagnostic', () => {
  it('runs detection and response generation without exposing the API key', async () => {
    await expect(
      runAnthropicDiagnostic({
        detectObjection: vi.fn(async () => ({
          isObjection: true,
          type: 'price',
          confidence: 0.86,
          triggerText: '費用が高い',
          reasoning: '価格懸念',
        })),
        generateObjectionResponse: vi.fn(async () => ({
          layer1Peek: '分割提案',
          layer2Summary: {
            mainResponse: '対象範囲を分けて検討しましょう',
            keyPoints: ['範囲を絞る', '時期を分ける', '判断材料を出す'],
          },
          layer3Detail: {
            fullScript: '費用面の懸念は自然です。対象範囲と導入時期を分けて検討しましょう。',
            rationale: '価格懸念に対する整理',
            cautions: [],
            similarCases: [],
          },
          confidence: 0.9,
          riskFlags: [],
        })),
      }),
    ).resolves.toMatchObject({
      configured: true,
      authenticated: true,
      detectionOk: true,
      responseOk: true,
      samplePeak: '分割提案',
      error: null,
    });
  });

  it('reports authentication failure without throwing', async () => {
    await expect(
      runAnthropicDiagnostic({
        detectObjection: vi.fn(async () => {
          throw new Error('401 invalid x-api-key');
        }),
        generateObjectionResponse: vi.fn(async () => {
          throw new Error('should not run');
        }),
      }),
    ).resolves.toMatchObject({
      configured: true,
      authenticated: false,
      detectionOk: false,
      responseOk: false,
      samplePeak: null,
      error: '401 invalid x-api-key',
    });
  });
});
