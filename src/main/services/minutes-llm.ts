import { z } from 'zod';
import type { ProductId, Transcript } from '@shared/types';
import { formatMmSs } from '@shared/time';
import { logger } from '../logger';
import { maskPiiInText } from './pii';

/**
 * 商談後議事録の LLM 生成。prompts/sonnet/meeting_minutes.ja.yaml の意図を実装する。
 * コンプラ findings はルールエンジン側の責務(2軸計画 §3.3: LLM は補助)なのでここでは扱わない。
 * 失敗時は呼び出し元(ipc)がヒューリスティック生成へフォールバックする。
 */

export interface MinutesGenerationRequest {
  productId: ProductId;
  /** `[mm:ss] 話者: 発話` 形式。PII マスク済み。 */
  transcriptLines: string[];
}

export interface MinutesLlmProvider {
  generateMeetingMinutes(input: MinutesGenerationRequest): Promise<unknown>;
}

export const MinutesLlmOutputSchema = z.object({
  summary: z.string().min(1).max(2_000),
  agreed: z.array(z.string().min(1)).max(10),
  pending: z.array(z.string().min(1)).max(10),
  decisions: z.array(z.string().min(1)).max(10),
});

export type MinutesLlmOutput = z.infer<typeof MinutesLlmOutputSchema>;

/** 入力 transcript が空のときは LLM を呼ばない(空議事録の捏造防止)。 */
export const MEETING_MINUTES_SYSTEM_PROMPT = `あなたはBtoB商談の議事録作成者です。
入力はタイムスタンプ付きの商談 transcript です。必ずJSONのみを返してください。
PIIは入力時点でマスク済み前提です。出力に新たな個人情報を推測して補完しないでください。
transcriptに無い事実を創作しないでください。該当がない項目は空配列にしてください。
decisions / agreed / pending の各項目は、根拠となる発話の "[mm:ss] " を先頭に付けてください(入力行のタイムスタンプをそのまま使う)。
出力形式:
{
  "summary": "商談全体の概要。3〜4文。",
  "agreed": ["[mm:ss] 両者が合意した事項"],
  "pending": ["[mm:ss] 保留・宿題・未解決の論点"],
  "decisions": ["[mm:ss] 決定事項"]
}`;

export function buildMinutesTranscriptLines(transcripts: Transcript[]): string[] {
  return transcripts
    .filter((transcript) => transcript.isFinal)
    .map((transcript) => {
      const text = maskPiiInText(transcript.text.trim());
      if (!text) {
        return null;
      }
      const speaker = transcript.speaker === 'self' ? '自分' : '相手';
      return `[${formatMmSs(transcript.startMs)}] ${speaker}: ${text}`;
    })
    .filter((line): line is string => line !== null);
}

export class MinutesLlmService {
  constructor(private readonly provider: MinutesLlmProvider) {}

  async generate(input: {
    productId: ProductId;
    transcripts: Transcript[];
  }): Promise<MinutesLlmOutput | null> {
    const transcriptLines = buildMinutesTranscriptLines(input.transcripts);
    if (transcriptLines.length === 0) {
      return null;
    }

    const raw = await this.provider.generateMeetingMinutes({
      productId: input.productId,
      transcriptLines,
    });
    return MinutesLlmOutputSchema.parse(raw);
  }
}

/**
 * ランタイム解決: mock → Anthropic → 失敗なら null(呼び出し元がヒューリスティックへ)。
 * provider 解決を遅延 import しているのは electron 依存(secrets)をテストから切り離すため。
 */
export async function tryGenerateLlmMinutesContent(
  productId: ProductId,
  transcripts: Transcript[],
): Promise<MinutesLlmOutput | null> {
  try {
    const { isMockPipelineEnabled } = await import('./dev-mode');
    if (isMockPipelineEnabled()) {
      return new MinutesLlmService(new DevelopmentMockMinutesProvider()).generate({
        productId,
        transcripts,
      });
    }

    const { createAnthropicLlmProvider } = await import('./anthropic');
    const provider = await createAnthropicLlmProvider();
    return await new MinutesLlmService(provider).generate({ productId, transcripts });
  } catch (error) {
    logger.warn({ error }, 'llm minutes generation degraded to heuristic');
    return null;
  }
}

export class DevelopmentMockMinutesProvider implements MinutesLlmProvider {
  async generateMeetingMinutes(input: MinutesGenerationRequest): Promise<unknown> {
    const firstLine = input.transcriptLines[0] ?? '[00:00] 相手: (発話なし)';
    const timestamp = firstLine.slice(0, 7);
    return {
      summary: `development mock 議事録。${input.transcriptLines.length} 発話を対象に生成しました。`,
      agreed: [],
      pending: [`${timestamp} ${firstLine.slice(8)}`],
      decisions: [`${timestamp} mock 決定事項`],
    };
  }
}
