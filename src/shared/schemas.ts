import { z } from 'zod';

/**
 * Runtime validation schemas for IPC and API boundaries.
 * Per PRD §23: every IPC payload must pass through zod before use.
 */

export const ProductIdSchema = z.enum(['real_estate', 'kenko_keiei', 'hojokin']);
export const SpeakerSchema = z.enum(['self', 'counterpart']);
export const OverlayLayerSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

export const PermissionStateSchema = z.object({
  screen: z.boolean(),
  microphone: z.boolean(),
});

export const InterimTranscriptSchema = z.object({
  speaker: SpeakerSchema,
  text: z.string(),
  isFinal: z.literal(false),
  startMs: z.number(),
});

export const FinalTranscriptSchema = z.object({
  speaker: SpeakerSchema,
  text: z.string(),
  isFinal: z.literal(true),
  startMs: z.number(),
  endMs: z.number(),
});

export const TranscriptSchema = z.discriminatedUnion('isFinal', [
  InterimTranscriptSchema,
  FinalTranscriptSchema,
]);

export const DetectedObjectionSchema = z.object({
  id: z.string().uuid(),
  type: z.string(),
  confidence: z.number().min(0).max(1),
  triggerText: z.string(),
  detectedAt: z.number(),
});

export const HaikuDetectionOutputSchema = z.object({
  isObjection: z.boolean(),
  type: z.string(),
  confidence: z.number().min(0).max(1),
  triggerText: z.string(),
  reasoning: z.string(),
});

export const SonnetResponseOutputSchema = z.object({
  layer1Peek: z.string().max(15),
  layer2Summary: z.object({
    mainResponse: z.string(),
    keyPoints: z.array(z.string()).max(3),
  }),
  layer3Detail: z.object({
    fullScript: z.string(),
    rationale: z.string(),
    cautions: z.array(z.string()),
    similarCases: z.array(z.string()),
  }),
  confidence: z.number().min(0).max(1),
  riskFlags: z.array(z.string()),
});

export const ObjectionResponseSchema = z.object({
  id: z.string().uuid(),
  objectionId: z.string().uuid(),
  peak: z.string().max(15),
  summary: z.array(z.string()).max(5),
  fullScript: z.string(),
  reasoning: z.string(),
  notes: z.array(z.string()),
  riskFlags: z.array(z.string()),
  generatedAtMs: z.number(),
});

export const SharingStateSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not_sharing') }),
  z.object({ status: z.literal('verifying') }),
  z.object({ status: z.literal('sharing') }),
  z.object({ status: z.literal('protection_failed') }),
]);

export const CallStateSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('uninitialized') }),
  z.object({ status: z.literal('setup') }),
  z.object({ status: z.literal('idle') }),
  z.object({
    status: z.literal('in_call'),
    productId: ProductIdSchema,
    startedAt: z.number(),
  }),
  z.object({ status: z.literal('error'), message: z.string() }),
]);

export const AppSettingsSchema = z.object({
  selectedProductId: ProductIdSchema.nullable(),
  overlayPosition: z.object({
    x: z.number(),
    y: z.number(),
    display: z.number(),
  }),
  hotkeys: z.record(z.string()),
  consentNoticeMode: z.enum(['verbal', 'zoom_background', 'sdk']),
  schemaVersion: z.number().int().nonnegative(),
});

export const AppSettingsPatchSchema = AppSettingsSchema.partial();

export const FeedbackSchema = z.object({
  objectionResponseId: z.string().uuid(),
  used: z.boolean(),
  reason: z.string().max(500).optional(),
});

export const SecretKeySchema = z.enum([
  'deepgram_api_key',
  'anthropic_api_key',
  'cohere_api_key',
  'supabase_anon_key',
  'sentry_dsn',
  'posthog_key',
]);

export const SecretSetInputSchema = z.object({
  key: SecretKeySchema,
  value: z.string().min(1),
});

export const KnowledgeSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(500),
  productId: ProductIdSchema,
  limit: z.number().int().min(1).max(20).optional(),
});

export const KnowledgeEntrySchema = z.object({
  id: z.string().uuid(),
  productId: ProductIdSchema,
  objectionType: z.string(),
  trigger: z.string(),
  response: z.string(),
  reasoning: z.string(),
  riskFlags: z.array(z.string()),
  embedding: z.array(z.number()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ObjectionDismissInputSchema = z.string().uuid();

export const AppErrorSchema = z.object({
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  category: z.enum(['network', 'api', 'permission', 'audio', 'database', 'llm', 'storage', 'unknown']),
  code: z.string().min(1),
  message: z.string().min(1),
  technicalMessage: z.string().optional(),
  recoverable: z.boolean(),
  recoveryAction: z.enum(['retry', 'fallback', 'user_action', 'restart']).optional(),
  context: z.record(z.unknown()).optional(),
});

export type ProductIdInput = z.infer<typeof ProductIdSchema>;
export type OverlayLayerInput = z.infer<typeof OverlayLayerSchema>;
export type SecretKeyInput = z.infer<typeof SecretKeySchema>;
export type AppSettingsPatchInput = z.infer<typeof AppSettingsPatchSchema>;
export type AppErrorInput = z.infer<typeof AppErrorSchema>;
export type HaikuDetectionOutputInput = z.infer<typeof HaikuDetectionOutputSchema>;
export type SonnetResponseOutputInput = z.infer<typeof SonnetResponseOutputSchema>;
