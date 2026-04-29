import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@anthropic-ai/sdk/resources/messages';
import {
  AnthropicLlmProvider,
  parseJsonFromMessage,
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
        max_tokens: 1_200,
        temperature: 0.2,
      }),
    );
  });
});
