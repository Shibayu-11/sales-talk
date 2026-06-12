import { SHORT_UTTERANCE_FILTER_CHARS } from '@shared/constants';
import type { DetectedObjection, ObjectionResponse, ProductId, Transcript } from '@shared/types';
import type { KnowledgeSearchService } from './knowledge';
import type { ObjectionLlmService } from './llm';

/**
 * Per PRD §4.6: 相手発話終了 → オーバーレイ表示 2.5s 以内。
 * 実機検証で段階別の所要時間を判定できるよう、final transcript 受信を起点に計測する。
 * STT の確定遅延と overlay 描画は含まない(main プロセス内の処理時間のみ)。
 */
export interface ObjectionPipelineTiming {
  objectionId: string | null;
  detected: boolean;
  transcriptChars: number;
  /** wall-clock ms when the final counterpart transcript entered the pipeline */
  transcriptReceivedAt: number;
  detectMs: number;
  knowledgeMs: number | null;
  generateMs: number | null;
  totalMs: number;
}

export interface ObjectionPipelineCallbacks {
  onDetected?: ((objection: DetectedObjection) => void) | undefined;
  onResponseReady?: ((response: ObjectionResponse) => void) | undefined;
  onCancelled?: ((objectionId: string) => void) | undefined;
  onError?: ((error: unknown) => void) | undefined;
  onTiming?: ((timing: ObjectionPipelineTiming) => void) | undefined;
}

export interface ObjectionPipelineServiceOptions {
  llm: ObjectionLlmService;
  knowledge: KnowledgeSearchService;
  getProductId: () => ProductId | null;
  callbacks?: ObjectionPipelineCallbacks | undefined;
  knowledgeLimit?: number | undefined;
  contextWindowSize?: number | undefined;
}

export class ObjectionPipelineService {
  private readonly knowledgeLimit: number;
  private readonly contextWindowSize: number;
  private readonly recentCounterpartFinals: string[] = [];
  private activeRunId = 0;

  constructor(private readonly options: ObjectionPipelineServiceOptions) {
    this.knowledgeLimit = options.knowledgeLimit ?? 5;
    this.contextWindowSize = options.contextWindowSize ?? 6;
  }

  async handleTranscript(transcript: Transcript): Promise<void> {
    if (!shouldProcessTranscript(transcript)) {
      return;
    }

    this.rememberCounterpartFinal(transcript.text);

    const productId = this.options.getProductId();
    if (!productId) {
      return;
    }

    const runId = this.nextRunId();
    const transcriptReceivedAt = Date.now();
    try {
      const recentContext = this.recentCounterpartFinals.join('\n');
      const objection = await this.options.llm.detect({
        productId,
        utterance: transcript.text,
        recentContext,
      });
      const detectDoneAt = Date.now();

      if (!this.isCurrentRun(runId)) {
        return;
      }

      if (!objection) {
        this.options.callbacks?.onTiming?.({
          objectionId: null,
          detected: false,
          transcriptChars: transcript.text.length,
          transcriptReceivedAt,
          detectMs: detectDoneAt - transcriptReceivedAt,
          knowledgeMs: null,
          generateMs: null,
          totalMs: detectDoneAt - transcriptReceivedAt,
        });
        return;
      }

      this.options.callbacks?.onDetected?.(objection);

      const knowledgeEntries = await this.options.knowledge.search({
        query: objection.triggerText,
        productId,
        limit: this.knowledgeLimit,
      });
      const knowledgeDoneAt = Date.now();

      if (!this.isCurrentRun(runId)) {
        this.options.callbacks?.onCancelled?.(objection.id);
        return;
      }

      const response = await this.options.llm.generateResponse({
        productId,
        objection,
        transcript: recentContext,
        knowledgeEntries,
      });
      const generateDoneAt = Date.now();

      if (!this.isCurrentRun(runId)) {
        this.options.callbacks?.onCancelled?.(objection.id);
        return;
      }

      this.options.callbacks?.onResponseReady?.(response);
      this.options.callbacks?.onTiming?.({
        objectionId: objection.id,
        detected: true,
        transcriptChars: transcript.text.length,
        transcriptReceivedAt,
        detectMs: detectDoneAt - transcriptReceivedAt,
        knowledgeMs: knowledgeDoneAt - detectDoneAt,
        generateMs: generateDoneAt - knowledgeDoneAt,
        totalMs: generateDoneAt - transcriptReceivedAt,
      });
    } catch (error) {
      if (this.isCurrentRun(runId)) {
        this.options.callbacks?.onError?.(error);
      }
    }
  }

  cancelActive(): void {
    this.nextRunId();
  }

  private rememberCounterpartFinal(text: string): void {
    this.recentCounterpartFinals.push(text);
    while (this.recentCounterpartFinals.length > this.contextWindowSize) {
      this.recentCounterpartFinals.shift();
    }
  }

  private nextRunId(): number {
    this.activeRunId += 1;
    return this.activeRunId;
  }

  private isCurrentRun(runId: number): boolean {
    return this.activeRunId === runId;
  }
}

export function shouldProcessTranscript(transcript: Transcript): boolean {
  return (
    transcript.isFinal &&
    transcript.speaker === 'counterpart' &&
    transcript.text.trim().length > SHORT_UTTERANCE_FILTER_CHARS
  );
}
