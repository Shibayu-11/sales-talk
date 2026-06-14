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
  ObjectionResponseSource,
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

/**
 * A knowledge entry passed to the LLM. Accepts plain KnowledgeEntry as well as
 * KnowledgeSearchResult (which adds a hybrid-RRF `score`) without breaking callers.
 */
export type ResponseKnowledgeEntry = KnowledgeEntry & { score?: number };

export interface ResponseGenerationRequest {
  productId: ProductId;
  objection: DetectedObjection;
  transcript: string;
  knowledgeEntries: ResponseKnowledgeEntry[];
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

    // Map the model-cited ids back to the retrieved entries to build citations.
    // The guardrail runs above and is never bypassed by source attribution.
    const sources = resolveSources(input.knowledgeEntries, output.knowledgeSourceIds);

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
      sources,
      generatedAtMs: Date.now(),
    };

    return ObjectionResponseSchema.parse(response);
  }
}

/**
 * Resolve the knowledge citations for the card.
 * - Map model-cited ids back to the retrieved entries (preserving cite order).
 * - If the model cited none but knowledge WAS retrieved, fall back to the top-1
 *   retrieved entry so the card always shows grounding when knowledge existed.
 * - If no knowledge was retrieved, return [].
 */
export function resolveSources(
  knowledgeEntries: ResponseKnowledgeEntry[],
  citedIds: string[],
): ObjectionResponseSource[] {
  if (knowledgeEntries.length === 0) {
    return [];
  }

  const byId = new Map(knowledgeEntries.map((entry) => [entry.id, entry]));
  const cited: ResponseKnowledgeEntry[] = [];
  const seen = new Set<string>();
  for (const id of citedIds) {
    const entry = byId.get(id);
    if (entry && !seen.has(entry.id)) {
      cited.push(entry);
      seen.add(entry.id);
    }
  }

  // top-1 is the first retrieved entry (search results are score-sorted upstream).
  const chosen = cited.length > 0 ? cited : [knowledgeEntries[0]!];

  return chosen.map((entry): ObjectionResponseSource => {
    const trigger = maskPiiInText(entry.trigger);
    if (typeof entry.score === 'number') {
      return { knowledgeId: entry.id, trigger, score: entry.score };
    }
    return { knowledgeId: entry.id, trigger };
  });
}
