import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { AudioSttJobSchema } from '@shared/schemas';
import type { AudioSttJob } from '@shared/types';
import { writeFileAtomic } from './atomic-file';

const LocalSttJobDataSchema = z.object({
  jobs: z.array(AudioSttJobSchema),
});

type LocalSttJobData = z.infer<typeof LocalSttJobDataSchema>;

function createDefaultSttJobData(): LocalSttJobData {
  return { jobs: [] };
}

export class LocalSttJobStore {
  private cache: LocalSttJobData | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = join(defaultUserDataPath(), 'local-stt-jobs.json')) {}

  async createJob(input: {
    callId: string;
    audioAssetId: string;
    provider?: AudioSttJob['provider'] | undefined;
    attempt?: number | undefined;
    retryReason?: string | null | undefined;
  }): Promise<AudioSttJob> {
    return this.mutate(async (data) => {
      const job = createQueuedJob({
        callId: input.callId,
        audioAssetId: input.audioAssetId,
        provider: input.provider ?? 'deepgram',
        attempt: input.attempt ?? 1,
        retryReason: input.retryReason ?? null,
      });
      return {
        next: { jobs: [job, ...data.jobs] },
        result: job,
      };
    });
  }

  async listJobs(callId: string): Promise<AudioSttJob[]> {
    const data = await this.get();
    return data.jobs.filter((job) => job.callId === callId);
  }

  async getJob(id: string): Promise<AudioSttJob | null> {
    const data = await this.get();
    return data.jobs.find((job) => job.id === id) ?? null;
  }

  async retryJob(input: {
    jobId: string;
    reason: string;
    provider?: AudioSttJob['provider'] | undefined;
  }): Promise<AudioSttJob> {
    return this.mutate(async (data) => {
      const job = data.jobs.find((candidate) => candidate.id === input.jobId);
      if (!job) {
        throw new Error('STT job was not found');
      }
      if (!isRetryableStatus(job.status)) {
        throw new Error('STT job retry requires a terminal job');
      }
      const retry = createQueuedJob({
        callId: job.callId,
        audioAssetId: job.audioAssetId,
        provider: input.provider ?? job.provider,
        attempt: job.attempt + 1,
        retryReason: input.reason,
      });
      return {
        next: { jobs: [retry, ...data.jobs] },
        result: retry,
      };
    });
  }

  async claimQueued(id: string, runToken: string): Promise<AudioSttJob> {
    return this.mutate(async (data) => {
      const job = findJobOrThrow(data, id);
      if (job.status === 'cancelled') {
        return { next: data, result: job };
      }
      if (job.status !== 'queued') {
        throw new Error('STT job runner only accepts queued jobs');
      }

      const now = new Date().toISOString();
      const nextJob: AudioSttJob = {
        ...job,
        status: 'running',
        runToken,
        progressPercent: 10,
        errorMessage: null,
        startedAt: job.startedAt ?? now,
        completedAt: null,
        updatedAt: now,
      };
      return replaceJob(data, nextJob);
    });
  }

  async updateProgress(
    id: string,
    runToken: string,
    progressPercent: number,
  ): Promise<AudioSttJob> {
    return this.mutate(async (data) => {
      const job = findJobOrThrow(data, id);
      if (job.status === 'cancelled') {
        return { next: data, result: job };
      }
      assertRunningToken(job, runToken);
      return replaceJob(data, {
        ...job,
        progressPercent,
        updatedAt: new Date().toISOString(),
      });
    });
  }

  async completeJob(input: {
    id: string;
    runToken: string;
    transcriptRevisionId: string;
  }): Promise<AudioSttJob> {
    return this.mutate(async (data) => {
      const job = findJobOrThrow(data, input.id);
      if (job.status === 'cancelled') {
        return { next: data, result: job };
      }
      assertRunningToken(job, input.runToken);
      const now = new Date().toISOString();
      return replaceJob(data, {
        ...job,
        status: 'completed',
        runToken: null,
        progressPercent: 100,
        transcriptRevisionId: input.transcriptRevisionId,
        errorMessage: null,
        completedAt: now,
        updatedAt: now,
      });
    });
  }

  async failJob(input: {
    id: string;
    runToken: string;
    errorMessage: string;
    transcriptRevisionId?: string | undefined;
  }): Promise<AudioSttJob> {
    return this.mutate(async (data) => {
      const job = findJobOrThrow(data, input.id);
      if (job.status === 'cancelled') {
        return { next: data, result: job };
      }
      assertRunningToken(job, input.runToken);
      const now = new Date().toISOString();
      return replaceJob(data, {
        ...job,
        status: 'failed',
        runToken: null,
        errorMessage: input.errorMessage,
        transcriptRevisionId: input.transcriptRevisionId ?? job.transcriptRevisionId,
        completedAt: now,
        updatedAt: now,
      });
    });
  }

  async requestCancel(id: string): Promise<AudioSttJob> {
    return this.mutate(async (data) => {
      const job = data.jobs.find((candidate) => candidate.id === id);
      if (!job) {
        throw new Error('STT job was not found');
      }
      if (job.status === 'cancelled') {
        return { next: data, result: job };
      }
      if (job.status !== 'queued' && job.status !== 'running') {
        throw new Error('STT job cancellation requires a queued or running job');
      }
      if (job.status === 'running' && job.progressPercent >= 90) {
        throw new Error('STT job cancellation is no longer available');
      }

      const nextJob: AudioSttJob = {
        ...job,
        status: 'cancelled',
        runToken: null,
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return {
        next: {
          jobs: data.jobs.map((candidate) => (candidate.id === id ? nextJob : candidate)),
        },
        result: nextJob,
      };
    });
  }

  private async get(): Promise<LocalSttJobData> {
    if (this.cache) {
      return this.cache;
    }

    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = LocalSttJobDataSchema.parse(JSON.parse(raw));
      const reconciled = reconcileInterruptedRunningJobs(parsed);
      if (reconciled !== parsed) {
        await this.persist(reconciled);
      }
      this.cache = reconciled;
      return this.cache;
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        throw error;
      }
      const initialized = createDefaultSttJobData();
      await this.persist(initialized);
      this.cache = initialized;
      return this.cache;
    }
  }

  private mutate<T>(
    operation: (data: LocalSttJobData) => Promise<{ next: LocalSttJobData; result: T }>,
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

  private async persist(data: LocalSttJobData): Promise<void> {
    await writeFileAtomic(this.filePath, `${JSON.stringify(data, null, 2)}\n`);
  }
}

export const localSttJobStore = new LocalSttJobStore();

function defaultUserDataPath(): string {
  return process.env.SALES_TALK_USER_DATA_PATH ?? app?.getPath?.('userData') ?? process.cwd();
}

function createQueuedJob(input: {
  callId: string;
  audioAssetId: string;
  provider: AudioSttJob['provider'];
  attempt: number;
  retryReason: string | null;
}): AudioSttJob {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    callId: input.callId,
    audioAssetId: input.audioAssetId,
    provider: input.provider,
    status: 'queued',
    runToken: null,
    progressPercent: 0,
    attempt: input.attempt,
    retryReason: input.retryReason,
    transcriptRevisionId: null,
    errorMessage: null,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isRetryableStatus(status: AudioSttJob['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function findJobOrThrow(data: LocalSttJobData, id: string): AudioSttJob {
  const job = data.jobs.find((candidate) => candidate.id === id);
  if (!job) {
    throw new Error('STT job was not found');
  }
  return job;
}

function replaceJob(
  data: LocalSttJobData,
  nextJob: AudioSttJob,
): { next: LocalSttJobData; result: AudioSttJob } {
  return {
    next: {
      jobs: data.jobs.map((candidate) => (candidate.id === nextJob.id ? nextJob : candidate)),
    },
    result: nextJob,
  };
}

function assertRunningToken(job: AudioSttJob, runToken: string): void {
  if (job.status !== 'running' || job.runToken !== runToken) {
    throw new Error('STT job run token is no longer active');
  }
}

function reconcileInterruptedRunningJobs(data: LocalSttJobData): LocalSttJobData {
  if (!data.jobs.some((job) => job.status === 'running')) {
    return data;
  }

  const now = new Date().toISOString();
  return {
    jobs: data.jobs.map((job) => {
      if (job.status !== 'running') {
        return job;
      }
      return {
        ...job,
        status: 'failed',
        runToken: null,
        errorMessage: 'STT processing was interrupted',
        completedAt: now,
        updatedAt: now,
      };
    }),
  };
}
