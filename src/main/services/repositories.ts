import type {
  ActionItemTask,
  AudioAsset,
  AudioSttJob,
  AuditLogEntry,
  AuditLogFilter,
  AuditIntegrityResult,
  CallSession,
  ComplianceRule,
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
  TranscriptSegment,
} from '@shared/types';
import type { ComplianceRuleCreateInput, KnowledgeCreateInput } from '@shared/schemas';
import { localActivityStore } from './local-activity-store';
import { localAudioAssetStore } from './local-audio-asset-store';
import { localCallStore } from './local-call-store';
import { localComplianceStore } from './local-compliance-store';
import { localKnowledgeStore } from './local-knowledge-store';
import { localOrganizationStore } from './local-organization-store';
import { localSttJobStore } from './local-stt-job-store';
import { localTranscriptStore } from './local-transcript-store';

export interface KnowledgeEntryRepository {
  list(productId: ProductId): Promise<KnowledgeEntry[]>;
  search(query: string, productId: ProductId, limit: number): Promise<KnowledgeEntry[]>;
  create(input: KnowledgeCreateInput): Promise<KnowledgeEntry>;
  delete(id: string): Promise<void>;
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
  listTranscripts(callId: string): Promise<TranscriptSegment[]>;
}

export interface AudioAssetRepository {
  importAudioFile(input: { callId: string; filePath: string }): Promise<AudioAsset>;
  listAudioAssets(callId: string): Promise<AudioAsset[]>;
}

export interface AudioSttJobRepository {
  createJob(input: {
    callId: string;
    audioAssetId: string;
    provider?: AudioSttJob['provider'] | undefined;
  }): Promise<AudioSttJob>;
  listJobs(callId: string): Promise<AudioSttJob[]>;
  getJob(id: string): Promise<AudioSttJob | null>;
  updateJobStatus(
    id: string,
    status: AudioSttJob['status'],
    errorMessage?: string | null,
  ): Promise<AudioSttJob>;
}

export interface MinutesRepository {
  getLatestMeetingMinute(): Promise<MeetingMinute | null>;
  setLatestMeetingMinute(minute: MeetingMinute): Promise<MeetingMinute>;
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
  ): Promise<ComplianceRule[]>;
  createRule(input: ComplianceRuleCreateInput): Promise<ComplianceRule>;
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
