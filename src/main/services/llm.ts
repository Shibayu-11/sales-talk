import { randomUUID } from 'node:crypto';
import {
  HaikuDetectionOutputSchema,
  ObjectionResponseSchema,
  SonnetResponseOutputSchema,
} from '@shared/schemas';
import type {
  DetectedObjection,
  KnowledgeEntry,
  ObjectionResponse,
  ProductId,
} from '@shared/types';
import { HAIKU_CONFIDENCE_THRESHOLD } from '@shared/constants';
import { applyOutputGuardrail } from './guardrail';
import { maskPiiInText } from './pii';

export interface DetectionRequest {
  productId: ProductId;
  utterance: string;
  recentContext: string;
}

export interface ResponseGenerationRequest {
  productId: ProductId;
  objection: DetectedObjection;
  transcript: string;
  knowledgeEntries: KnowledgeEntry[];
}

export interface LlmProvider {
  detectObjection(input: DetectionRequest): Promise<unknown>;
  generateObjectionResponse(input: ResponseGenerationRequest): Promise<unknown>;
}

export class ObjectionLlmService {
  constructor(private readonly provider: LlmProvider) {}

  async detect(input: DetectionRequest): Promise<DetectedObjection | null> {
    const safeInput: DetectionRequest = {
      productId: input.productId,
      utterance: maskPiiInText(input.utterance),
      recentContext: maskPiiInText(input.recentContext),
    };
    const output = HaikuDetectionOutputSchema.parse(await this.provider.detectObjection(safeInput));

    if (!output.isObjection || output.confidence < HAIKU_CONFIDENCE_THRESHOLD) {
      return null;
    }

    return {
      id: randomUUID(),
      type: output.type,
      confidence: output.confidence,
      triggerText: maskPiiInText(output.triggerText),
      detectedAt: Date.now(),
    };
  }

  async generateResponse(input: ResponseGenerationRequest): Promise<ObjectionResponse> {
    const safeInput: ResponseGenerationRequest = {
      productId: input.productId,
      objection: {
        ...input.objection,
        triggerText: maskPiiInText(input.objection.triggerText),
      },
      transcript: maskPiiInText(input.transcript),
      knowledgeEntries: input.knowledgeEntries.map((entry) => ({
        ...entry,
        trigger: maskPiiInText(entry.trigger),
        response: maskPiiInText(entry.response),
        reasoning: maskPiiInText(entry.reasoning),
      })),
    };
    const output = SonnetResponseOutputSchema.parse(
      await this.provider.generateObjectionResponse(safeInput),
    );
    const guarded = applyOutputGuardrail({
      productId: input.productId,
      text: output.layer3Detail.fullScript,
      riskFlags: output.riskFlags,
    });

    const response: ObjectionResponse = {
      id: randomUUID(),
      objectionId: input.objection.id,
      peak: guarded.allowed ? output.layer1Peek : '専門家確認',
      summary: guarded.allowed ? output.layer2Summary.keyPoints : [guarded.safeText],
      fullScript: guarded.safeText,
      reasoning: guarded.allowed ? output.layer3Detail.rationale : 'ガードレールにより安全文面へ差し替え',
      notes: guarded.allowed
        ? output.layer3Detail.cautions
        : guarded.violations.map((violation) => violation.label),
      riskFlags: guarded.riskFlags,
      generatedAtMs: Date.now(),
    };

    return ObjectionResponseSchema.parse(response);
  }
}
