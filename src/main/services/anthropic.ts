import Anthropic from '@anthropic-ai/sdk';
import type { ContentBlock, Message } from '@anthropic-ai/sdk/resources/messages';
import type {
  DetectionRequest,
  LlmProvider,
  ObjectionLlmService,
  ResponseGenerationRequest,
} from './llm';
import { ObjectionLlmService as RuntimeObjectionLlmService } from './llm';
import type { MinutesGenerationRequest, MinutesLlmProvider } from './minutes-llm';
import { MEETING_MINUTES_SYSTEM_PROMPT } from './minutes-llm';
import type { AnthropicDiagnosticResult, DetectedObjection } from '@shared/types';
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

export class AnthropicLlmProvider implements LlmProvider, MinutesLlmProvider {
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
      max_tokens: 2_000,
      temperature: 0.2,
      system: buildResponseSystemPrompt(input.productId),
      messages: [{ role: 'user', content: buildResponsePrompt(input) }],
    });

    return parseJsonFromMessage(message);
  }

  async generateMeetingMinutes(input: MinutesGenerationRequest): Promise<unknown> {
    const message = await this.options.client.messages.create({
      model: this.options.sonnetModel,
      max_tokens: 2_000,
      temperature: 0.2,
      system: MEETING_MINUTES_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildMinutesPrompt(input) }],
    });

    return parseJsonFromMessage(message);
  }
}

function buildMinutesPrompt(input: MinutesGenerationRequest): string {
  return JSON.stringify(
    {
      product_id: input.productId,
      transcript: input.transcriptLines,
    },
    null,
    2,
  );
}

export async function createAnthropicLlmProvider(): Promise<AnthropicLlmProvider> {
  const apiKey = await secretStore.get('anthropic_api_key');
  if (!apiKey) {
    throw new Error('Anthropic API key is not configured');
  }

  return new AnthropicLlmProvider({
    client: new Anthropic({ apiKey, timeout: 45_000, maxRetries: 1 }),
    haikuModel: process.env.ANTHROPIC_HAIKU_MODEL ?? 'claude-haiku-4-5',
    sonnetModel: process.env.ANTHROPIC_SONNET_MODEL ?? 'claude-sonnet-4-6',
  });
}

export function getAnthropicModelNames(): { haikuModel: string; sonnetModel: string } {
  return {
    haikuModel: process.env.ANTHROPIC_HAIKU_MODEL ?? 'claude-haiku-4-5',
    sonnetModel: process.env.ANTHROPIC_SONNET_MODEL ?? 'claude-sonnet-4-6',
  };
}

export async function runAnthropicDiagnostic(
  provider?: LlmProvider,
  serviceFactory: (provider: LlmProvider) => ObjectionLlmService = (llmProvider) =>
    new RuntimeObjectionLlmService(llmProvider),
): Promise<AnthropicDiagnosticResult> {
  const startedAt = Date.now();
  const models = getAnthropicModelNames();
  try {
    const llmProvider = provider ?? (await createAnthropicLlmProvider());
    const service = serviceFactory(llmProvider);
    const detected = await service.detect({
      productId: 'kenko_keiei',
      utterance: '費用が高くて、今すぐ導入する判断は難しいです。',
      recentContext: '健康経営優良法人の申請支援について説明中です。',
    });
    const objection = detected ?? createDiagnosticObjection();
    const response = await service.generateResponse({
      productId: 'kenko_keiei',
      objection,
      transcript: '費用が高くて、今すぐ導入する判断は難しいです。',
      knowledgeEntries: [],
    });

    return {
      configured: true,
      authenticated: true,
      ...models,
      detectionOk: Boolean(detected),
      responseOk: response.fullScript.length > 0,
      latencyMs: Date.now() - startedAt,
      samplePeak: response.peak,
      error: null,
    };
  } catch (error) {
    return {
      configured: error instanceof Error && error.message.includes('not configured') ? false : true,
      authenticated: false,
      ...models,
      detectionOk: false,
      responseOk: false,
      latencyMs: Date.now() - startedAt,
      samplePeak: null,
      error: error instanceof Error ? error.message : 'anthropic_diagnostic_failed',
    };
  }
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
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    return fenced[1];
  }
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
}

function createDiagnosticObjection(): DetectedObjection {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    type: 'price',
    confidence: 0.8,
    triggerText: '費用が高くて、今すぐ導入する判断は難しいです。',
    detectedAt: Date.now(),
  };
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
        id: entry.id,
        objection_type: entry.objectionType,
        trigger: entry.trigger,
        response: entry.response,
        reasoning: entry.reasoning,
        risk_flags: entry.riskFlags,
        // score is present only when callers pass KnowledgeSearchResult[]
        ...('score' in entry && typeof entry.score === 'number' ? { score: entry.score } : {}),
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

ナレッジの活用(最重要):
- 入力の knowledge_entries は、自社で検証済みの反論対応ナレッジです。切り返しの一次情報源として最優先で活用してください。
- knowledge_entries に該当する内容がある場合は、一般論よりも knowledge_entries の response / reasoning を根拠として優先してください。
- 実際に根拠として用いた knowledge_entries の id を、使用した順(関連度の高い順)に knowledgeSourceIds 配列へ列挙してください。
- knowledge_entries を一切使わなかった場合のみ knowledgeSourceIds を空配列 [] にしてください。存在しない id を捏造しないでください。
- knowledge_entries が空、または該当が無い場合は、一般論で安全に回答し、knowledgeSourceIds は [] にしてください。

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
  "riskFlags": string[],
  "knowledgeSourceIds": string[]
}`;
}
