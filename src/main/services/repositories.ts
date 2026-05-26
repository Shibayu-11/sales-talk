import type {
  ActionItemTask,
  AuditLogEntry,
  CallSession,
  ComplianceRule,
  Industry,
  KnowledgeEntry,
  MeetingMinute,
  ProductId,
  ReviewTask,
} from '@shared/types';
import type { ComplianceRuleCreateInput, KnowledgeCreateInput } from '@shared/schemas';
import { localActivityStore } from './local-activity-store';
import { localCallStore } from './local-call-store';
import { localComplianceStore } from './local-compliance-store';
import { localKnowledgeStore } from './local-knowledge-store';

export interface KnowledgeEntryRepository {
  list(productId: ProductId): Promise<KnowledgeEntry[]>;
  search(query: string, productId: ProductId, limit: number): Promise<KnowledgeEntry[]>;
  create(input: KnowledgeCreateInput): Promise<KnowledgeEntry>;
  delete(id: string): Promise<void>;
}

export interface CallRepository {
  createCall(input: {
    source: CallSession['source'];
    industry: CallSession['industry'];
    productId: CallSession['productId'];
    startedAt?: Date | undefined;
  }): Promise<CallSession>;
  endCall(id: string, endedAt?: Date): Promise<CallSession>;
  listCalls(): Promise<CallSession[]>;
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
}

export interface ComplianceRuleRepository {
  listRules(industry?: Industry): Promise<ComplianceRule[]>;
  createRule(input: ComplianceRuleCreateInput): Promise<ComplianceRule>;
  deleteRule(id: string): Promise<void>;
}

export interface AppRepositories {
  calls: CallRepository;
  knowledge: KnowledgeEntryRepository;
  minutes: MinutesRepository;
  tasks: ActionItemTaskRepository;
  reviews: ReviewTaskRepository;
  auditLogs: AuditLogRepository;
  complianceRules: ComplianceRuleRepository;
}

export const appRepositories: AppRepositories = {
  calls: localCallStore,
  knowledge: localKnowledgeStore,
  minutes: localActivityStore,
  tasks: localActivityStore,
  reviews: localActivityStore,
  auditLogs: localActivityStore,
  complianceRules: localComplianceStore,
};
