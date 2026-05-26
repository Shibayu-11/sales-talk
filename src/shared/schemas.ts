import { z } from 'zod';

/**
 * Runtime validation schemas for IPC and API boundaries.
 * Per PRD §23: every IPC payload must pass through zod before use.
 */

export const ProductIdSchema = z.enum(['real_estate', 'kenko_keiei', 'hojokin']);
export const MeetingSourceSchema = z.enum([
  'zoom_desktop',
  'mobile_recording',
  'uploaded_audio',
  'manual_transcript',
]);
export const IndustrySchema = z.enum(['btob_sales', 'insurance']);
export const SpeakerSchema = z.enum(['self', 'counterpart']);
export const OverlayLayerSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

export const AudioChunkSchema = z.object({
  speaker: SpeakerSchema,
  data: z.string().min(1),
  startMs: z.number().nonnegative(),
  durationMs: z.number().positive(),
});

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

export const ComplianceSeveritySchema = z.enum(['critical', 'high', 'medium', 'low']);
export const ComplianceRuleTypeSchema = z.enum([
  'prohibited_expression',
  'caution_expression',
  'required_disclosure',
]);
export const ComplianceReviewStatusSchema = z.enum([
  'unreviewed',
  'approved',
  'dismissed',
  'escalated',
]);
export const ReviewTaskStatusSchema = z.enum([
  'open',
  'approved',
  'dismissed',
  'training_required',
  'escalated',
]);
export const AuditActorTypeSchema = z.enum(['system', 'user', 'ai']);
export const AuditActionSchema = z.enum([
  'minutes.generated',
  'compliance.finding_detected',
  'review_task.created',
  'review_task.status_updated',
]);

export const ComplianceRuleSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().min(1),
  industry: IndustrySchema,
  productCategory: z.string().min(1),
  severity: ComplianceSeveritySchema,
  ruleType: ComplianceRuleTypeSchema,
  pattern: z.string().min(1),
  reason: z.string().min(1),
  recommendedPhrase: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ComplianceFindingSchema = z.object({
  id: z.string().uuid(),
  ruleId: z.string().uuid(),
  severity: ComplianceSeveritySchema,
  ruleType: ComplianceRuleTypeSchema,
  quotedText: z.string(),
  reason: z.string(),
  recommendedAction: z.string(),
  reviewStatus: ComplianceReviewStatusSchema,
  detectedAtMs: z.number(),
});

export const ReviewTaskSchema = z.object({
  id: z.string().uuid(),
  callId: z.string().uuid(),
  meetingMinuteId: z.string().uuid(),
  findingId: z.string().uuid(),
  severity: ComplianceSeveritySchema,
  status: ReviewTaskStatusSchema,
  title: z.string().min(1).max(200),
  quotedText: z.string(),
  reason: z.string(),
  recommendedAction: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ReviewTaskUpdateStatusInputSchema = z.object({
  id: z.string().uuid(),
  status: ReviewTaskStatusSchema,
});

export const AuditLogEntrySchema = z.object({
  id: z.string().uuid(),
  actorType: AuditActorTypeSchema,
  action: AuditActionSchema,
  targetType: z.string().min(1).max(120),
  targetId: z.string().min(1).max(120),
  metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
  createdAt: z.string(),
});

export const PresentationRiskLevelSchema = z.enum(['none', 'low', 'medium', 'high', 'critical']);
export const PresentationBlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('summary_card'),
    title: z.string(),
    body: z.string(),
    riskLevel: PresentationRiskLevelSchema,
  }),
  z.object({
    type: z.literal('risk_item'),
    label: z.string(),
    quote: z.string(),
    severity: ComplianceSeveritySchema,
    suggestion: z.string(),
  }),
  z.object({
    type: z.literal('transcript_quote'),
    speaker: SpeakerSchema,
    quote: z.string(),
    startMs: z.number(),
  }),
  z.object({
    type: z.literal('action_list'),
    items: z.array(z.string()),
  }),
  z.object({
    type: z.literal('review_decision'),
    taskId: z.string().uuid(),
    status: ReviewTaskStatusSchema,
  }),
  z.object({
    type: z.literal('metric_card'),
    label: z.string(),
    value: z.string(),
    trend: z.string().optional(),
  }),
  z.object({
    type: z.literal('table'),
    columns: z.array(z.string()),
    rows: z.array(z.array(z.string())),
  }),
]);

export const ComplianceRuleCreateInputSchema = z.object({
  companyId: z.string().trim().min(1).max(120),
  industry: IndustrySchema,
  productCategory: z.string().trim().min(1).max(120),
  severity: ComplianceSeveritySchema,
  ruleType: ComplianceRuleTypeSchema,
  pattern: z.string().trim().min(1).max(500),
  reason: z.string().trim().min(1).max(1_000),
  recommendedPhrase: z.string().trim().min(1).max(1_000),
});

export const ComplianceRuleDeleteInputSchema = z.string().uuid();

export const MeetingMinuteSchema = z.object({
  id: z.string().uuid(),
  callId: z.string().uuid(),
  source: MeetingSourceSchema,
  productId: ProductIdSchema,
  summary: z.string(),
  agreed: z.array(z.string()),
  pending: z.array(z.string()),
  decisions: z.array(z.string()),
  numbers: z.array(z.object({ label: z.string(), value: z.string() })),
  complianceFindings: z.array(ComplianceFindingSchema),
  generatedAt: z.string(),
});

export const MinutesGenerateInputSchema = z.object({
  productId: ProductIdSchema,
  transcripts: z.array(TranscriptSchema).max(100),
  source: MeetingSourceSchema.default('manual_transcript'),
});

export const TaskOwnerSchema = z.enum(['own', 'customer', 'joint']);

export const TaskDueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('explicit'), date: z.string() }),
  z.object({ kind: z.literal('inferred'), date: z.string() }),
  z.object({ kind: z.literal('none') }),
]);

export const ActionItemTaskSchema = z.object({
  id: z.string().uuid(),
  callId: z.string().uuid(),
  owner: TaskOwnerSchema,
  description: z.string().min(1).max(500),
  due: TaskDueSchema,
  completed: z.boolean(),
  createdAt: z.string(),
});

export const TaskCreateInputSchema = z.object({
  owner: TaskOwnerSchema,
  description: z.string().trim().min(1).max(500),
});

export const TaskCompleteInputSchema = z.object({
  id: z.string().uuid(),
  completed: z.boolean(),
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

export const CallLifecycleStatusSchema = z.enum(['active', 'ended']);

export const CallSessionSchema = z.object({
  id: z.string().uuid(),
  source: MeetingSourceSchema,
  industry: IndustrySchema,
  productId: ProductIdSchema,
  status: CallLifecycleStatusSchema,
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const TranscriptSegmentSchema = z.object({
  id: z.string().uuid(),
  callId: z.string().uuid(),
  speaker: SpeakerSchema,
  text: z.string(),
  isFinal: z.boolean(),
  startMs: z.number(),
  endMs: z.number().nullable(),
  createdAt: z.string(),
});

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

export const KnowledgeCreateInputSchema = z.object({
  productId: ProductIdSchema,
  objectionType: z.string().trim().min(1).max(80),
  trigger: z.string().trim().min(1).max(500),
  response: z.string().trim().min(1).max(2_000),
  reasoning: z.string().trim().max(1_000).optional(),
  riskFlags: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
});

export const KnowledgeDeleteInputSchema = z.string().uuid();

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

export const DevInjectTranscriptInputSchema = TranscriptSchema;

export type ProductIdInput = z.infer<typeof ProductIdSchema>;
export type AudioChunkInput = z.infer<typeof AudioChunkSchema>;
export type OverlayLayerInput = z.infer<typeof OverlayLayerSchema>;
export type SecretKeyInput = z.infer<typeof SecretKeySchema>;
export type AppSettingsPatchInput = z.infer<typeof AppSettingsPatchSchema>;
export type AppErrorInput = z.infer<typeof AppErrorSchema>;
export type HaikuDetectionOutputInput = z.infer<typeof HaikuDetectionOutputSchema>;
export type SonnetResponseOutputInput = z.infer<typeof SonnetResponseOutputSchema>;
export type KnowledgeCreateInput = z.infer<typeof KnowledgeCreateInputSchema>;
export type ComplianceRuleCreateInput = z.infer<typeof ComplianceRuleCreateInputSchema>;
export type ReviewTaskUpdateStatusInput = z.infer<typeof ReviewTaskUpdateStatusInputSchema>;
