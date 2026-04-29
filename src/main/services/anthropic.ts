import Anthropic from '@anthropic-ai/sdk';
import type { ContentBlock, Message } from '@anthropic-ai/sdk/resources/messages';
import type {
  DetectionRequest,
  LlmProvider,
  ResponseGenerationRequest,
} from './llm';
import { secretStore } from './secrets';

interface AnthropicMessagesClient {
  messages: {
    create(input: {
      model: string;
      max_tokens: number;
      temperature?: number;
      system: string;
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    }): Promise<Message>;
  };
}

export interface AnthropicProviderOptions {
  client: AnthropicMessagesClient;
  haikuModel: string;
  sonnetModel: string;
}

export class AnthropicLlmProvider implements LlmProvider {
  constructor(private readonly options: AnthropicProviderOptions) {}

  async detectObjection(input: DetectionRequest): Promise<unknown> {
    const message = await this.options.client.messages.create({
      model: this.options.haikuModel,
      max_tokens: 300,
      temperature: 0,
      system: HAIKU_DETECTION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildDetectionPrompt(input) }],
    });

    return parseJsonFromMessage(message);
  }

  async generateObjectionResponse(input: ResponseGenerationRequest): Promise<unknown> {
    const message = await this.options.client.messages.create({
      model: this.options.sonnetModel,
      max_tokens: 1_200,
      temperature: 0.2,
      system: buildResponseSystemPrompt(input.productId),
      messages: [{ role: 'user', content: buildResponsePrompt(input) }],
    });

    return parseJsonFromMessage(message);
  }
}

export async function createAnthropicLlmProvider(): Promise<AnthropicLlmProvider> {
  const apiKey = await secretStore.get('anthropic_api_key');
  if (!apiKey) {
    throw new Error('Anthropic API key is not configured');
  }

  return new AnthropicLlmProvider({
    client: new Anthropic({ apiKey, timeout: 5_000, maxRetries: 1 }),
    haikuModel: process.env.ANTHROPIC_HAIKU_MODEL ?? 'claude-haiku-4-5',
    sonnetModel: process.env.ANTHROPIC_SONNET_MODEL ?? 'claude-sonnet-4-6',
  });
}

export function parseJsonFromMessage(message: Message): unknown {
  const text = message.content.map(contentBlockToText).join('\n').trim();
  if (!text) {
    throw new Error('Anthropic response did not include text content');
  }

  return JSON.parse(stripJsonCodeFence(text));
}

function contentBlockToText(block: ContentBlock): string {
  return block.type === 'text' ? block.text : '';
}

function stripJsonCodeFence(text: string): string {
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1] ?? text;
}

function buildDetectionPrompt(input: DetectionRequest): string {
  return JSON.stringify(
    {
      product_id: input.productId,
      utterance: input.utterance,
      recent_context: input.recentContext,
    },
    null,
    2,
  );
}

function buildResponsePrompt(input: ResponseGenerationRequest): string {
  return JSON.stringify(
    {
      product_id: input.productId,
      objection: input.objection,
      transcript: input.transcript,
      knowledge_entries: input.knowledgeEntries.map((entry) => ({
        objection_type: entry.objectionType,
        trigger: entry.trigger,
        response: entry.response,
        reasoning: entry.reasoning,
        risk_flags: entry.riskFlags,
      })),
    },
    null,
    2,
  );
}

const HAIKU_DETECTION_SYSTEM_PROMPT = `あなたはBtoB商談中の反論検知器です。
入力された相手発話だけを評価し、JSONのみを返してください。
判定対象外: 相槌、情報確認、同意、Zoom操作確認。
出力形式:
{
  "isObjection": boolean,
  "type": "price" | "timing" | "authority" | "status_quo" | "trust" | "competitor" | "none",
  "confidence": number,
  "triggerText": string,
  "reasoning": string
}`;

function buildResponseSystemPrompt(productId: string): string {
  return `あなたはBtoB商談中の営業支援アシスタントです。
必ずJSONのみを返してください。
出力前に商材別ガードレールを自己確認し、リスクがあればriskFlagsへ記載してください。
商材: ${productId}
出力形式:
{
  "layer1Peek": "15文字以内",
  "layer2Summary": {
    "mainResponse": "200-250文字",
    "keyPoints": ["40文字以内", "40文字以内", "40文字以内"]
  },
  "layer3Detail": {
    "fullScript": "500-800文字",
    "rationale": string,
    "cautions": string[],
    "similarCases": string[]
  },
  "confidence": number,
  "riskFlags": string[]
}`;
}
