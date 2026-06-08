/**
 * Shared types between Main and Renderer.
 * Keep this file dependency-free (no zod, no node, no electron imports).
 */

export type ProductId = 'real_estate' | 'kenko_keiei' | 'hojokin';

export type MeetingSource =
  | 'zoom_desktop'
  | 'mobile_recording'
  | 'uploaded_audio'
  | 'manual_transcript';

export type Industry = 'btob_sales' | 'insurance';
export type OrganizationType = 'insurer' | 'agency' | 'internal';
export type OrganizationRole = 'insurer_admin' | 'agency_admin' | 'manager' | 'agent' | 'auditor';
export type OrganizationPermission =
  | 'recording:start'
  | 'calls:read'
  | 'reviews:manage'
  | 'rules:manage'
  | 'rules:approve'
  | 'organization:manage';
export type RecordingConsentStatus = 'pending' | 'granted' | 'declined' | 'not_required';
export type RecordingConsentMethod =
  | 'verbal'
  | 'written'
  | 'digital'
  | 'upload_attestation'
  | 'not_applicable';

export type Speaker = 'self' | 'counterpart';

export type ObjectionType =
  | 'price'
  | 'timing'
  | 'authority'
  | 'status_quo'
  | 'trust'
  | 'competitor'
  // Product-specific extension points (added at runtime per product)
  | string;

export interface AudioChunk {
  speaker: Speaker;
  /** PCM 16-bit LE, 16kHz, mono. Base64 when crossing IPC. */
  data: string;
  startMs: number;
  durationMs: number;
}

export interface InterimTranscript {
  speaker: Speaker;
  text: string;
  isFinal: false;
  startMs: number;
}

export interface FinalTranscript {
  speaker: Speaker;
  text: string;
  isFinal: true;
  startMs: number;
  endMs: number;
}

export type Transcript = InterimTranscript | FinalTranscript;

export interface DetectedObjection {
  id: string;
  type: ObjectionType;
  confidence: number;
  triggerText: string;
  detectedAt: number;
}

export interface ObjectionResponse {
  id: string;
  objectionId: string;
  /** Layer 1: peak label (≤ 15 chars per PRD §12.2) */
  peak: string;
  /** Layer 2: 3-line summary */
  summary: string[];
  /** Layer 3: full script */
  fullScript: string;
  reasoning: string;
  notes: string[];
  /** Per PRD §16: guardrail risk flags */
  riskFlags: string[];
  generatedAtMs: number;
}

export type CallState =
  | { status: 'uninitialized' }
  | { status: 'setup' }
  | { status: 'idle' }
  | { status: 'in_call'; productId: ProductId; startedAt: number }
  | { status: 'error'; message: string };

export type SharingState =
  | { status: 'not_sharing' }
  | { status: 'verifying' }
  | { status: 'sharing' }
  | { status: 'protection_failed' };

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface AudioCaptureSourceStats {
  chunks: number;
  bytes: number;
  lastReceivedAtMs: number | null;
}

export interface AudioCaptureStats {
  self: AudioCaptureSourceStats;
  counterpart: AudioCaptureSourceStats;
  total: AudioCaptureSourceStats;
}

export interface AudioCaptureStatus {
  nativeModule: {
    available: boolean;
    contractValid: boolean;
    modulePath: string;
    error?: string | undefined;
  };
  permissions: PermissionState;
  stats: AudioCaptureStats;
  sttState: ConnectionState;
  nativeCaptureActive: boolean;
}

export interface AppInfo {
  bundleId: string;
  name: string;
  windowCount: number;
  iconBase64?: string;
}

export interface PermissionState {
  screen: boolean;
  microphone: boolean;
}

export interface AppSettings {
  selectedProductId: ProductId | null;
  overlayPosition: { x: number; y: number; display: number };
  hotkeys: Record<string, string>;
  consentNoticeMode: 'verbal' | 'zoom_background' | 'sdk';
  /** Per PRD §31: keep deprecated keys for 3 months */
  schemaVersion: number;
}

export type CallLifecycleStatus = 'active' | 'ended';

export interface Tenant {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface Organization {
  id: string;
  tenantId: string;
  parentOrganizationId: string | null;
  type: OrganizationType;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppUser {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationMembership {
  id: string;
  tenantId: string;
  organizationId: string;
  userId: string;
  role: OrganizationRole;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationUser extends AppUser {
  membershipId: string;
  tenantId: string;
  organizationId: string;
  role: OrganizationRole;
  permissions: OrganizationPermission[];
}

export interface CurrentUserContext {
  user: AppUser;
  tenant: Tenant;
  organization: Organization;
  membership: OrganizationMembership;
  permissions: OrganizationPermission[];
}

export interface RecordingConsent {
  status: RecordingConsentStatus;
  method: RecordingConsentMethod | null;
  capturedAt: string | null;
  noticeVersion: string;
}

export interface CallSession {
  id: string;
  tenantId: string;
  organizationId: string;
  source: MeetingSource;
  industry: Industry;
  productId: ProductId;
  recordingConsent: RecordingConsent;
  status: CallLifecycleStatus;
  startedAt: string;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TranscriptSegment {
  id: string;
  callId: string;
  speaker: Speaker;
  text: string;
  isFinal: boolean;
  startMs: number;
  endMs: number | null;
  createdAt: string;
}

export interface AudioAsset {
  id: string;
  callId: string;
  fileName: string;
  originalPath: string;
  storedPath: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface AudioImportResult {
  call: CallSession;
  asset: AudioAsset;
}

export interface AudioImportProcessResult extends AudioImportResult {
  job: AudioSttJob;
  meetingMinute: MeetingMinute | null;
}

export type AudioSttJobStatus = 'queued' | 'running' | 'completed' | 'failed';
export type AudioSttProvider = 'deepgram';

export interface AudioSttJob {
  id: string;
  callId: string;
  audioAssetId: string;
  provider: AudioSttProvider;
  status: AudioSttJobStatus;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeEntry {
  id: string;
  productId: ProductId;
  objectionType: ObjectionType;
  trigger: string;
  response: string;
  reasoning: string;
  riskFlags: string[];
  /** Per PRD §17: chunked as one objection-response pair */
  embedding?: number[];
  createdAt: string;
  updatedAt: string;
}

export interface MeetingMinute {
  id: string;
  callId: string;
  source: MeetingSource;
  productId: ProductId;
  summary: string;
  agreed: string[];
  pending: string[];
  decisions: string[];
  numbers: { label: string; value: string }[];
  complianceFindings: ComplianceFinding[];
  generatedAt: string;
}

export type ComplianceSeverity = 'critical' | 'high' | 'medium' | 'low';
export type ComplianceRuleType =
  | 'prohibited_expression'
  | 'caution_expression'
  | 'required_disclosure';
export type ComplianceReviewStatus = 'unreviewed' | 'approved' | 'dismissed' | 'escalated';
export type ComplianceRuleSetApprovalStatus = 'draft' | 'pending_review' | 'approved' | 'rejected';
export type ReviewTaskStatus =
  | 'open'
  | 'approved'
  | 'dismissed'
  | 'training_required'
  | 'escalated';
export type AuditActorType = 'system' | 'user' | 'ai';
export type AuditAction =
  | 'recording.started'
  | 'recording.consent_captured'
  | 'organization.user_role_updated'
  | 'compliance.rule_set_created'
  | 'compliance.rule_set_active_updated'
  | 'compliance.rule_created'
  | 'compliance.rule_updated'
  | 'compliance.rule_deleted'
  | 'compliance.rule_set_submitted'
  | 'compliance.rule_set_approved'
  | 'compliance.rule_set_rejected'
  | 'compliance.rule_set_revision_created'
  | 'minutes.generated'
  | 'compliance.finding_detected'
  | 'review_task.created'
  | 'review_task.status_updated'
  | 'call.audio_imported'
  | 'stt_job.created';

export interface ComplianceRule {
  id: string;
  ruleSetId: string;
  tenantId: string;
  organizationId: string;
  /** Deprecated compatibility alias. Use organizationId. */
  companyId: string;
  industry: Industry;
  productCategory: string;
  severity: ComplianceSeverity;
  ruleType: ComplianceRuleType;
  pattern: string;
  reason: string;
  recommendedPhrase: string;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export interface ComplianceRuleSet {
  id: string;
  tenantId: string;
  organizationId: string;
  parentRuleSetId: string | null;
  name: string;
  productCategory: string;
  presetKey: string | null;
  active: boolean;
  version: number;
  approvalStatus: ComplianceRuleSetApprovalStatus;
  approvedAt: string | null;
  approvedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ComplianceFinding {
  id: string;
  ruleId: string;
  severity: ComplianceSeverity;
  ruleType: ComplianceRuleType;
  quotedText: string;
  reason: string;
  recommendedAction: string;
  reviewStatus: ComplianceReviewStatus;
  detectedAtMs: number;
}

export interface ReviewTask {
  id: string;
  callId: string;
  meetingMinuteId: string;
  findingId: string;
  severity: ComplianceSeverity;
  status: ReviewTaskStatus;
  title: string;
  quotedText: string;
  reason: string;
  recommendedAction: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuditLogEntry {
  id: string;
  tenantId: string | null;
  organizationId: string | null;
  actorType: AuditActorType;
  actorUserId: string | null;
  actorMembershipId: string | null;
  actorDisplayName: string | null;
  actorRole: OrganizationRole | null;
  action: AuditAction;
  targetType: string;
  targetId: string;
  metadata: Record<string, string | number | boolean | null>;
  previousHash: string | null;
  hash: string | null;
  createdAt: string;
}

export interface AuditIntegrityResult {
  valid: boolean;
  checkedEntries: number;
  invalidEntryId: string | null;
}

export type AuditExportFormat = 'csv' | 'pdf';

export interface AuditLogFilter {
  query?: string | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  action?: AuditAction | undefined;
  actor?: string | undefined;
}

export type PresentationRiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';

export type PresentationBlock =
  | {
      type: 'summary_card';
      title: string;
      body: string;
      riskLevel: PresentationRiskLevel;
    }
  | {
      type: 'risk_item';
      label: string;
      quote: string;
      severity: ComplianceSeverity;
      suggestion: string;
    }
  | {
      type: 'transcript_quote';
      speaker: Speaker;
      quote: string;
      startMs: number;
    }
  | {
      type: 'action_list';
      items: string[];
    }
  | {
      type: 'review_decision';
      taskId: string;
      status: ReviewTaskStatus;
    }
  | {
      type: 'metric_card';
      label: string;
      value: string;
      trend?: string;
    }
  | {
      type: 'table';
      columns: string[];
      rows: string[][];
    };

export type TaskOwner = 'own' | 'customer' | 'joint';
export type TaskDue = { kind: 'explicit'; date: string } | { kind: 'inferred'; date: string } | { kind: 'none' };

export interface ActionItemTask {
  id: string;
  callId: string;
  owner: TaskOwner;
  description: string;
  due: TaskDue;
  completed: boolean;
  createdAt: string;
}

export type ErrorSeverity = 'critical' | 'high' | 'medium' | 'low';
export type ErrorCategory =
  | 'network'
  | 'api'
  | 'permission'
  | 'audio'
  | 'database'
  | 'llm'
  | 'storage'
  | 'unknown';

export interface AppError {
  severity: ErrorSeverity;
  category: ErrorCategory;
  code: string;
  message: string;
  technicalMessage?: string | undefined;
  recoverable: boolean;
  recoveryAction?: 'retry' | 'fallback' | 'user_action' | 'restart' | undefined;
  context?: Record<string, unknown> | undefined;
}

/**
 * Public surface exposed via `contextBridge` to the renderer.
 * Per PRD §23: Main is heavy, Renderer is thin.
 */
export interface RendererApi {
  app: {
    getVersion(): Promise<string>;
  };
  permissions: {
    check(): Promise<PermissionState>;
    requestScreen(): Promise<void>;
    requestMicrophone(): Promise<void>;
    onChange(cb: (state: PermissionState) => void): () => void;
  };
  call: {
    list(): Promise<CallSession[]>;
    start(productId: ProductId, consent: RecordingConsent): Promise<void>;
    end(): Promise<void>;
    setProduct(productId: ProductId): Promise<void>;
    onState(cb: (state: CallState) => void): () => void;
  };
  transcripts: {
    list(callId: string): Promise<TranscriptSegment[]>;
  };
  audio: {
    getStatus(): Promise<AudioCaptureStatus>;
    start(consent: RecordingConsent): Promise<void>;
    stop(): Promise<void>;
    onError(cb: (message: string) => void): () => void;
  };
  organizations: {
    getCurrentContext(): Promise<CurrentUserContext>;
    list(): Promise<Organization[]>;
    listUsers(): Promise<OrganizationUser[]>;
    updateUserRole(membershipId: string, role: OrganizationRole): Promise<OrganizationUser>;
  };
  auditLogs: {
    list(filter?: AuditLogFilter): Promise<AuditLogEntry[]>;
    verify(): Promise<AuditIntegrityResult>;
    export(format: AuditExportFormat, filter?: AuditLogFilter): Promise<string | null>;
  };
  audioAssets: {
    import(productId: ProductId, consent: RecordingConsent): Promise<AudioImportResult | null>;
    importAndProcess(
      productId: ProductId,
      consent: RecordingConsent,
    ): Promise<AudioImportProcessResult | null>;
    list(callId: string): Promise<AudioAsset[]>;
  };
  sttJobs: {
    create(audioAssetId: string): Promise<AudioSttJob>;
    run(jobId: string): Promise<AudioSttJob>;
    list(callId: string): Promise<AudioSttJob[]>;
  };
  stt: {
    onInterim(cb: (transcript: Transcript) => void): () => void;
    onFinal(cb: (transcript: Transcript) => void): () => void;
    onError(cb: (message: string) => void): () => void;
    onConnectionState(cb: (state: ConnectionState) => void): () => void;
  };
  objection: {
    onDetected(cb: (obj: DetectedObjection) => void): () => void;
    onResponseReady(cb: (resp: ObjectionResponse) => void): () => void;
    onCancelled(cb: (id: string) => void): () => void;
    submitFeedback(id: string, used: boolean, reason?: string): Promise<void>;
    dismiss(id: string): Promise<void>;
  };
  overlay: {
    setHover(isHover: boolean): Promise<void>;
    setLayer(layer: 1 | 2 | 3): Promise<void>;
    onSharingState(cb: (state: SharingState) => void): () => void;
  };
  knowledge: {
    search(query: string, productId: ProductId, limit?: number): Promise<KnowledgeEntry[]>;
    list(productId: ProductId): Promise<KnowledgeEntry[]>;
    create(input: {
      productId: ProductId;
      objectionType: string;
      trigger: string;
      response: string;
      reasoning?: string;
      riskFlags?: string[];
    }): Promise<KnowledgeEntry>;
    delete(id: string): Promise<void>;
  };
  minutes: {
    generate(
      productId: ProductId,
      transcripts: Transcript[],
      source?: MeetingSource,
    ): Promise<MeetingMinute>;
    get(): Promise<MeetingMinute | null>;
  };
  tasks: {
    list(): Promise<ActionItemTask[]>;
    create(owner: TaskOwner, description: string): Promise<ActionItemTask>;
    complete(id: string, completed: boolean): Promise<ActionItemTask>;
  };
  reviews: {
    list(): Promise<ReviewTask[]>;
    updateStatus(id: string, status: ReviewTaskStatus): Promise<ReviewTask>;
  };
  compliance: {
    listRules(): Promise<ComplianceRule[]>;
    listRulesForSet(ruleSetId: string): Promise<ComplianceRule[]>;
    listRuleSets(): Promise<ComplianceRuleSet[]>;
    createRuleSet(input: {
      name: string;
      productCategory: string;
      presetKey?: string | undefined;
    }): Promise<ComplianceRuleSet>;
    setRuleSetActive(id: string, active: boolean): Promise<ComplianceRuleSet>;
    submitRuleSet(id: string): Promise<ComplianceRuleSet>;
    reviewRuleSet(id: string, approved: boolean): Promise<ComplianceRuleSet>;
    createRuleSetRevision(id: string): Promise<ComplianceRuleSet>;
    createRule(input: {
      ruleSetId: string;
      companyId: string;
      industry: Industry;
      productCategory: string;
      severity: ComplianceSeverity;
      ruleType: ComplianceRuleType;
      pattern: string;
      reason: string;
      recommendedPhrase: string;
      priority: number;
    }): Promise<ComplianceRule>;
    updateRule(input: {
      id: string;
      severity: ComplianceSeverity;
      ruleType: ComplianceRuleType;
      pattern: string;
      reason: string;
      recommendedPhrase: string;
      priority: number;
    }): Promise<ComplianceRule>;
    deleteRule(id: string): Promise<void>;
  };
  settings: {
    get(): Promise<AppSettings>;
    set(patch: Partial<AppSettings>): Promise<void>;
    onChange(cb: (settings: AppSettings) => void): () => void;
  };
  secrets: {
    set(key: string, value: string): Promise<void>;
    has(key: string): Promise<boolean>;
    delete(key: string): Promise<void>;
  };
  dev: {
    isEnabled(): Promise<boolean>;
    startMockCall(productId: ProductId): Promise<void>;
    endMockCall(): Promise<void>;
    injectTranscript(transcript: Transcript): Promise<void>;
  };
}

declare global {
  interface Window {
    api: RendererApi;
  }
}
