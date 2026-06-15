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

export const HAIKU_DETECTION_SYSTEM_PROMPT = `あなたはBtoB商談中の反論検知器です。
入力された相手発話だけを評価し、JSONのみを返してください。

判定対象外(isObjection=false にする): 相槌、情報確認、同意、雑談、Zoom操作確認、単なる質問。
「予算を確認します」「画面見えています」「なるほど」等は反論ではありません。

type の定義:
- price: 価格・費用・予算が高い/合わないという懸念
- timing: 導入時期・今ではないという先送り
- authority: 自分では決められない・上長/決裁が必要
- status_quo: 現状で困っていない・変える必要がない
- trust: 効果・実績・信頼性への疑問
- competitor: 他社/他案と比較・検討している

confidence スコア基準:
- 0.9-1.0: 明確な反論。懸念が言語化されている
- 0.7-0.89: 反論の兆候。文脈依存だが対応した方がよい
- 0.7未満: 弱い懸念や相槌寄り。isObjection は false 寄りで判断

判定例:
- "費用が高くて、今すぐの判断は難しいですね" → {"isObjection":true,"type":"price","confidence":0.9}
- "私の一存では決められないので持ち帰ります" → {"isObjection":true,"type":"authority","confidence":0.88}
- "今のやり方で特に困ってないんですよね" → {"isObjection":true,"type":"status_quo","confidence":0.85}
- "他社さんからも似た提案を受けています" → {"isObjection":true,"type":"competitor","confidence":0.82}
- "予算を確認しておきます" → {"isObjection":false,"type":"none","confidence":0.2}
- "画面は見えていますか?" → {"isObjection":false,"type":"none","confidence":0.0}

出力形式(JSONのみ):
{
  "isObjection": boolean,
  "type": "price" | "timing" | "authority" | "status_quo" | "trust" | "competitor" | "none",
  "confidence": number,
  "triggerText": string,
  "reasoning": string
}`;

/**
 * 商材別の proactive ガードレール。`guardrail.ts` の正規表現ルールと安全フォールバックに
 * 対応する内容を、生成前にLLMへ明示して違反そのものを減らす(事後フィルタは保険として残る)。
 * ここを変えたら guardrail.ts の RULES / SAFE_FALLBACKS と整合を取ること。
 */
const PRODUCT_GUARDRAIL_GUIDANCE: Record<string, string> = {
  real_estate: `不動産(宅建業法)の禁止事項:
- 重要事項説明そのものへの踏み込み・代筆指示をしない(例「重説にはこう書いて」❌)
- 利回りや元本の保証・断定をしない(例「年利5%は確実」❌)
- 節税効果の断定をしない(例「必ず節税になる」❌)
代わりに: 「重要事項は宅建士、税務は税理士、融資は金融機関に確認」と誘導し、利回りは「立地・築年数・融資条件で変動」と幅で語る。`,
  hojokin: `補助金・助成金(行政書士法)— 最高リスク。特に慎重に:
- 申請書の具体的な記載方法を指示しない(例「申請書にはこう書いて」❌)
- 採択を確約・保証しない(例「100%採択されます」❌)
- 虚偽申請・架空経費・水増しを一切助長しない ❌
代わりに: 「採択実績は目安」と明示し、申請書作成や事業計画は必ず「提携行政書士・中小企業診断士に確認」へ誘導する。`,
  kenko_keiei: `健康経営優良法人の禁止事項:
- 認定を確約・保証しない(例「ホワイト500は確実」❌)
- 効果の数値保証をしない(例「離職率が必ず下がる」❌)
- 診断・治療・処方など医療行為に踏み込まない ❌
代わりに: 「要件を満たす可能性」と可能性表現にとどめ、医療は産業医、労務は社労士へ誘導する。`,
};

export function buildResponseSystemPrompt(productId: string): string {
  const guardrail = PRODUCT_GUARDRAIL_GUIDANCE[productId] ?? '';
  return `あなたはBtoB商談中の営業支援アシスタントです。
必ずJSONのみを返してください。
商材: ${productId}

商材別ガードレール(生成前に必ず自己確認):
${guardrail}
上記に触れる内容を出力しそうな場合は表現を安全側へ言い換え、該当する懸念を riskFlags に記載してください。

ナレッジの活用(最重要):
- 入力の knowledge_entries は、自社で検証済みの反論対応ナレッジです。切り返しの一次情報源として最優先で活用してください。
- triggerText と knowledge_entries の trigger を意味的に比較し、合致するものがあれば一般論より優先して response / reasoning を根拠にしてください。
- 実際に根拠として用いた knowledge_entries の id を、関連度の高い順に knowledgeSourceIds 配列へ列挙してください。
- 重要: 入力に存在しない id を捏造しないでください。該当する知識が無い、または一切使わなかった場合のみ knowledgeSourceIds を空配列 [] にしてください。
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
