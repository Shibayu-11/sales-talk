import type {
  ActionItemTask,
  AuditLogEntry,
  ComplianceRule,
  Industry,
  KnowledgeEntry,
  MeetingMinute,
  ProductId,
  ReviewTask,
} from '@shared/types';
import type { ComplianceRuleCreateInput, KnowledgeCreateInput } from '@shared/schemas';
import { localActivityStore } from './local-activity-store';
import { localComplianceStore } from './local-compliance-store';
import { localKnowledgeStore } from './local-knowledge-store';

export interface KnowledgeEntryRepository {
  list(productId: ProductId): Promise<KnowledgeEntry[]>;
  search(query: string, productId: ProductId, limit: number): Promise<KnowledgeEntry[]>;
  create(input: KnowledgeCreateInput): Promise<KnowledgeEntry>;
  delete(id: string): Promise<void>;
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
  knowledge: KnowledgeEntryRepository;
  minutes: MinutesRepository;
  tasks: ActionItemTaskRepository;
  reviews: ReviewTaskRepository;
  auditLogs: AuditLogRepository;
  complianceRules: ComplianceRuleRepository;
}

export const appRepositories: AppRepositories = {
  knowledge: localKnowledgeStore,
  minutes: localActivityStore,
  tasks: localActivityStore,
  reviews: localActivityStore,
  auditLogs: localActivityStore,
  complianceRules: localComplianceStore,
};
