import { app } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  ActionItemTaskSchema,
  AuditLogEntrySchema,
  MeetingMinuteSchema,
  ReviewTaskSchema,
} from '@shared/schemas';
import type {
  ActionItemTask,
  AuditLogEntry,
  AuditLogFilter,
  MeetingMinute,
  ReviewTask,
} from '@shared/types';
import { signAuditLogEntries, verifyAuditLogChain } from './audit-integrity';
import { writeFileAtomic } from './atomic-file';

const LocalActivityDataSchema = z.object({
  latestMeetingMinute: MeetingMinuteSchema.nullable(),
  tasks: z.array(ActionItemTaskSchema),
  reviewTasks: z.array(ReviewTaskSchema).default([]),
  auditLogs: z.array(AuditLogEntrySchema).default([]),
});

interface LocalActivityData {
  latestMeetingMinute: MeetingMinute | null;
  tasks: ActionItemTask[];
  reviewTasks: ReviewTask[];
  auditLogs: AuditLogEntry[];
}

const DEFAULT_ACTIVITY_DATA: LocalActivityData = {
  latestMeetingMinute: null,
  tasks: [],
  reviewTasks: [],
  auditLogs: [],
};

export class LocalActivityStore {
  private cache: LocalActivityData | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = join(defaultUserDataPath(), 'local-activity.json')) {}

  async getLatestMeetingMinute(): Promise<MeetingMinute | null> {
    return (await this.get()).latestMeetingMinute;
  }

  async setLatestMeetingMinute(minute: MeetingMinute): Promise<MeetingMinute> {
    return this.mutate(async (data) => ({
      next: { ...data, latestMeetingMinute: minute },
      result: minute,
    }));
  }

  async listTasks(): Promise<ActionItemTask[]> {
    return (await this.get()).tasks;
  }

  async createTask(task: ActionItemTask): Promise<ActionItemTask> {
    return this.mutate(async (data) => ({
      next: { ...data, tasks: [task, ...data.tasks] },
      result: task,
    }));
  }

  async completeTask(id: string, completed: boolean): Promise<ActionItemTask> {
    return this.mutate(async (data) => {
      const task = data.tasks.find((candidate) => candidate.id === id);
      if (!task) {
        throw new Error('Task was not found');
      }

      const nextTask = { ...task, completed };
      return {
        next: {
          ...data,
          tasks: data.tasks.map((candidate) => (candidate.id === id ? nextTask : candidate)),
        },
        result: nextTask,
      };
    });
  }

  async listReviewTasks(): Promise<ReviewTask[]> {
    return (await this.get()).reviewTasks;
  }

  async createReviewTasks(tasks: ReviewTask[]): Promise<ReviewTask[]> {
    if (tasks.length === 0) {
      return [];
    }

    return this.mutate(async (data) => ({
      next: { ...data, reviewTasks: [...tasks, ...data.reviewTasks] },
      result: tasks,
    }));
  }

  async updateReviewTaskStatus(id: string, status: ReviewTask['status']): Promise<ReviewTask> {
    return this.mutate(async (data) => {
      const task = data.reviewTasks.find((candidate) => candidate.id === id);
      if (!task) {
        throw new Error('Review task was not found');
      }

      const nextTask = { ...task, status, updatedAt: new Date().toISOString() };
      return {
        next: {
          ...data,
          reviewTasks: data.reviewTasks.map((candidate) =>
            candidate.id === id ? nextTask : candidate,
          ),
        },
        result: nextTask,
      };
    });
  }

  async appendAuditLogs(entries: AuditLogEntry[]): Promise<AuditLogEntry[]> {
    if (entries.length === 0) {
      return [];
    }

    return this.mutate(async (data) => {
      const seenIds = new Set(data.auditLogs.map((entry) => entry.id));
      const newEntries = entries.filter((entry) => {
        if (seenIds.has(entry.id)) {
          return false;
        }
        seenIds.add(entry.id);
        return true;
      });
      if (newEntries.length === 0) {
        return { next: data, result: [] };
      }

      const previousHash = data.auditLogs[0]?.hash ?? null;
      const signedEntries = signAuditLogEntries(newEntries, previousHash);
      return {
        next: { ...data, auditLogs: [...signedEntries].reverse().concat(data.auditLogs) },
        result: signedEntries,
      };
    });
  }

  async listAuditLogs(
    scope: {
      tenantId: string;
      organizationId?: string | undefined;
    },
    filter: AuditLogFilter = {},
  ): Promise<AuditLogEntry[]> {
    return (await this.get()).auditLogs.filter(
      (entry) =>
        entry.tenantId === scope.tenantId &&
        (scope.organizationId === undefined || entry.organizationId === scope.organizationId) &&
        matchesAuditLogFilter(entry, filter),
    );
  }

  async verifyAuditLogs(scope: {
    tenantId: string;
    organizationId?: string | undefined;
  }): Promise<ReturnType<typeof verifyAuditLogChain>> {
    return verifyAuditLogChain(await this.listAuditLogs(scope));
  }

  private async get(): Promise<LocalActivityData> {
    if (this.cache) {
      return this.cache;
    }

    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = LocalActivityDataSchema.parse(JSON.parse(raw));
      if (parsed.auditLogs.some((entry) => entry.hash === null)) {
        parsed.auditLogs = signAuditLogEntries([...parsed.auditLogs].reverse(), null).reverse();
        await this.persist(parsed);
      }
      this.cache = parsed;
      return this.cache;
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        throw error;
      }
      const initialized = cloneDefaultActivityData();
      await this.persist(initialized);
      this.cache = initialized;
      return this.cache;
    }
  }

  private mutate<T>(
    operation: (data: LocalActivityData) => Promise<{ next: LocalActivityData; result: T }>,
  ): Promise<T> {
    const run = this.mutationQueue.then(async () => {
      const data = await this.get();
      const { next, result } = await operation(data);
      if (next !== data) {
        await this.persist(next);
        this.cache = next;
      }
      return result;
    });
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async persist(data: LocalActivityData): Promise<void> {
    await writeFileAtomic(this.filePath, `${JSON.stringify(data, null, 2)}\n`);
  }
}

export const localActivityStore = new LocalActivityStore();

function defaultUserDataPath(): string {
  return process.env.SALES_TALK_USER_DATA_PATH ?? app?.getPath?.('userData') ?? process.cwd();
}

function cloneDefaultActivityData(): LocalActivityData {
  return {
    latestMeetingMinute: DEFAULT_ACTIVITY_DATA.latestMeetingMinute,
    tasks: [],
    reviewTasks: [],
    auditLogs: [],
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function matchesAuditLogFilter(entry: AuditLogEntry, filter: AuditLogFilter): boolean {
  if (filter.action && entry.action !== filter.action) {
    return false;
  }
  if (filter.actor && !contains(entry.actorDisplayName ?? entry.actorType, filter.actor)) {
    return false;
  }
  if (filter.dateFrom && entry.createdAt < startOfDayIso(filter.dateFrom)) {
    return false;
  }
  if (filter.dateTo && entry.createdAt > endOfDayIso(filter.dateTo)) {
    return false;
  }
  if (filter.query) {
    const haystack = [
      entry.action,
      entry.targetType,
      entry.targetId,
      entry.actorDisplayName ?? '',
      entry.actorRole ?? '',
      JSON.stringify(entry.metadata),
      entry.hash ?? '',
    ].join('\n');
    return contains(haystack, filter.query);
  }
  return true;
}

function contains(value: string, query: string): boolean {
  return value.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

function startOfDayIso(date: string): string {
  return `${date.slice(0, 10)}T00:00:00.000Z`;
}

function endOfDayIso(date: string): string {
  return `${date.slice(0, 10)}T23:59:59.999Z`;
}
