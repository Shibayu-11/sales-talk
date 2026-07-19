import type {
  ActionItemTask,
  AudioAsset,
  AudioSttJob,
  AuditLogEntry,
  AuditLogFilter,
  AuditIntegrityResult,
  CallSession,
  ComplianceRule,
  ComplianceRuleSet,
  CurrentUserContext,
  Industry,
  KnowledgeEntry,
  MeetingMinute,
  ProductId,
  RecordingConsent,
  Organization,
  OrganizationPermission,
  OrganizationRole,
  OrganizationUser,
  ReviewTask,
  Transcript,
  TranscriptRevision,
  TranscriptSegment,
} from '@shared/types';
import type {
  ComplianceRuleCreateInput,
  ComplianceRuleUpdateInput,
  ComplianceRuleSetCreateInput,
  KnowledgeCreateInput,
} from '@shared/schemas';
import { localActivityStore } from './local-activity-store';
import { localAudioAssetStore, type AudioAssetReadableLease } from './local-audio-asset-store';
import { localCallStore } from './local-call-store';
import { localComplianceStore } from './local-compliance-store';
import {
  localKnowledgeStore,
  type KnowledgeEntryCreateMetadata,
  type KnowledgeScope,
} from './local-knowledge-store';
import { localOrganizationStore } from './local-organization-store';
import { localSttJobStore } from './local-stt-job-store';
import { localTranscriptStore } from './local-transcript-store';

export interface KnowledgeEntryRepository {
  list(productId: ProductId, scope?: KnowledgeScope): Promise<KnowledgeEntry[]>;
  search(
    query: string,
    productId: ProductId,
    limit: number,
    scope?: KnowledgeScope,
  ): Promise<KnowledgeEntry[]>;
  create(
    input: KnowledgeCreateInput,
    metadata?: KnowledgeEntryCreateMetadata,
  ): Promise<KnowledgeEntry>;
  delete(id: string, scope?: KnowledgeScope): Promise<void>;
}

export interface CallRepository {
  createCall(input: {
    tenantId: string;
    organizationId: string;
    source: CallSession['source'];
    industry: CallSession['industry'];
    productId: CallSession['productId'];
    recordingConsent: RecordingConsent;
    startedAt?: Date | undefined;
  }): Promise<CallSession>;
  endCall(id: string, endedAt?: Date): Promise<CallSession>;
  listCalls(): Promise<CallSession[]>;
}

export interface OrganizationRepository {
  getDefaultScope(): Promise<{ tenantId: string; organizationId: string }>;
  getCurrentContext(): Promise<CurrentUserContext>;
  listOrganizations(tenantId: string): Promise<Organization[]>;
  listUsers(tenantId: string): Promise<OrganizationUser[]>;
  updateUserRole(tenantId: string, membershipId: string, role: OrganizationRole): Promise<OrganizationUser>;
  assertPermission(permission: OrganizationPermission): Promise<CurrentUserContext>;
}

export interface TranscriptRepository {
  appendTranscript(callId: string, transcript: Transcript): Promise<TranscriptSegment>;
  listTranscripts(callId: string, revisionId?: string | undefined): Promise<TranscriptSegment[]>;
  commitRevision(input: {
    callId: string;
    sttJobId: string;
    audioAssetId: string;
    provider: TranscriptRevision['provider'];
    reason: string;
    transcripts: Transcript[];
  }): Promise<TranscriptRevision>;
  listRevisions(callId: string): Promise<TranscriptRevision[]>;
  activateRevision(
    callId: string,
    revisionId: string,
    expectedActiveRevisionId?: string | null | undefined,
  ): Promise<TranscriptRevision>;
}

export interface AudioAssetRepository {
  importAudioFile(input: { callId: string; filePath: string }): Promise<AudioAsset>;
  listAudioAssets(callId: string): Promise<AudioAsset[]>;
  materializeReadableAsset(asset: AudioAsset): Promise<AudioAssetReadableLease>;
}

export interface AudioSttJobRepository {
  createJob(input: {
    callId: string;
    audioAssetId: string;
    provider?: AudioSttJob['provider'] | undefined;
    attempt?: number | undefined;
    retryReason?: string | null | undefined;
  }): Promise<AudioSttJob>;
  listJobs(callId: string): Promise<AudioSttJob[]>;
  getJob(id: string): Promise<AudioSttJob | null>;
  claimQueued(id: string, runToken: string): Promise<AudioSttJob>;
  updateProgress(id: string, runToken: string, progressPercent: number): Promise<AudioSttJob>;
  completeJob(input: {
    id: string;
    runToken: string;
    transcriptRevisionId: string;
  }): Promise<AudioSttJob>;
  failJob(input: {
    id: string;
    runToken: string;
    errorMessage: string;
    transcriptRevisionId?: string | undefined;
  }): Promise<AudioSttJob>;
  requestCancel(id: string): Promise<AudioSttJob>;
  retryJob(input: {
    jobId: string;
    reason: string;
    provider?: AudioSttJob['provider'] | undefined;
  }): Promise<AudioSttJob>;
}

export interface MinutesRepository {
  getLatestMeetingMinute(): Promise<MeetingMinute | null>;
  getMeetingMinute(
    callId: string,
    transcriptRevisionId?: string | null | undefined,
  ): Promise<MeetingMinute | null>;
  bindLegacyAnalysisToRevision(
    callId: string,
    transcriptRevisionId: string,
  ): Promise<MeetingMinute | null>;
  setLatestMeetingMinute(minute: MeetingMinute): Promise<MeetingMinute>;
  setMeetingAnalysis(input: {
    minute: MeetingMinute;
    reviewTasks: ReviewTask[];
    setAsLatest?: boolean | undefined;
  }): Promise<{ minute: MeetingMinute; reviewTasks: ReviewTask[] }>;
}

export interface ActionItemTaskRepository {
  listTasks(): Promise<ActionItemTask[]>;
  createTask(task: ActionItemTask): Promise<ActionItemTask>;
  completeTask(id: string, completed: boolean): Promise<ActionItemTask>;
}

export interface ReviewTaskRepository {
  listReviewTasks(): Promise<ReviewTask[]>;
  createReviewTasks(tasks: ReviewTask[]): Promise<ReviewTask[]>;
  updateReviewTaskStatus(id: string, status: ReviewTask['status']): Promise<ReviewTask>;
}

export interface AuditLogRepository {
  appendAuditLogs(entries: AuditLogEntry[]): Promise<AuditLogEntry[]>;
  listAuditLogs(
    scope: { tenantId: string; organizationId?: string | undefined },
    filter?: AuditLogFilter | undefined,
  ): Promise<AuditLogEntry[]>;
  verifyAuditLogs(scope: {
    tenantId: string;
    organizationId?: string | undefined;
  }): Promise<AuditIntegrityResult>;
}

export interface ComplianceRuleRepository {
  listRules(
    industry?: Industry,
    scope?: { tenantId: string; organizationId: string },
    productCategory?: string,
  ): Promise<ComplianceRule[]>;
  listRuleSets(scope: { tenantId: string; organizationId: string }): Promise<ComplianceRuleSet[]>;
  listRulesForSet(ruleSetId: string): Promise<ComplianceRule[]>;
  createRuleSet(
    scope: { tenantId: string; organizationId: string },
    input: ComplianceRuleSetCreateInput,
  ): Promise<ComplianceRuleSet>;
  setRuleSetActive(id: string, active: boolean): Promise<ComplianceRuleSet>;
  submitRuleSet(id: string): Promise<ComplianceRuleSet>;
  reviewRuleSet(id: string, approved: boolean, approvedByUserId: string): Promise<ComplianceRuleSet>;
  createRuleSetRevision(id: string): Promise<ComplianceRuleSet>;
  createRule(input: ComplianceRuleCreateInput): Promise<ComplianceRule>;
  updateRule(input: ComplianceRuleUpdateInput): Promise<ComplianceRule>;
  deleteRule(id: string): Promise<void>;
}

export interface AppRepositories {
  calls: CallRepository;
  organizations: OrganizationRepository;
  transcripts: TranscriptRepository;
  audioAssets: AudioAssetRepository;
  sttJobs: AudioSttJobRepository;
  knowledge: KnowledgeEntryRepository;
  minutes: MinutesRepository;
  tasks: ActionItemTaskRepository;
  reviews: ReviewTaskRepository;
  auditLogs: AuditLogRepository;
  complianceRules: ComplianceRuleRepository;
}

export const appRepositories: AppRepositories = {
  calls: localCallStore,
  organizations: localOrganizationStore,
  transcripts: localTranscriptStore,
  audioAssets: localAudioAssetStore,
  sttJobs: localSttJobStore,
  knowledge: localKnowledgeStore,
  minutes: localActivityStore,
  tasks: localActivityStore,
  reviews: localActivityStore,
  auditLogs: localActivityStore,
  complianceRules: localComplianceStore,
};
