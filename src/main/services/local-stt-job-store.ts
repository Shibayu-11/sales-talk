import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { AudioSttJobSchema } from '@shared/schemas';
import type { AudioSttJob } from '@shared/types';

const LocalSttJobDataSchema = z.object({
  jobs: z.array(AudioSttJobSchema),
});

interface LocalSttJobData {
  jobs: AudioSttJob[];
}

const DEFAULT_STT_JOB_DATA: LocalSttJobData = {
  jobs: [],
};

export class LocalSttJobStore {
  private cache: LocalSttJobData | null = null;

  constructor(private readonly filePath = join(defaultUserDataPath(), 'local-stt-jobs.json')) {}

  async createJob(input: {
    callId: string;
    audioAssetId: string;
    provider?: AudioSttJob['provider'] | undefined;
  }): Promise<AudioSttJob> {
    const now = new Date().toISOString();
    const job: AudioSttJob = {
      id: randomUUID(),
      callId: input.callId,
      audioAssetId: input.audioAssetId,
      provider: input.provider ?? 'deepgram',
      status: 'queued',
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    };
    const data = await this.get();
    const next = { jobs: [job, ...data.jobs] };
    this.cache = next;
    await this.persist(next);
    return job;
  }

  async listJobs(callId: string): Promise<AudioSttJob[]> {
    const data = await this.get();
    return data.jobs.filter((job) => job.callId === callId);
  }

  async getJob(id: string): Promise<AudioSttJob | null> {
    const data = await this.get();
    return data.jobs.find((job) => job.id === id) ?? null;
  }

  async updateJobStatus(
    id: string,
    status: AudioSttJob['status'],
    errorMessage: string | null = null,
  ): Promise<AudioSttJob> {
    const data = await this.get();
    const job = data.jobs.find((candidate) => candidate.id === id);
    if (!job) {
      throw new Error('STT job was not found');
    }

    const nextJob: AudioSttJob = {
      ...job,
      status,
      errorMessage,
      updatedAt: new Date().toISOString(),
    };
    const next = {
      jobs: data.jobs.map((candidate) => (candidate.id === id ? nextJob : candidate)),
    };
    this.cache = next;
    await this.persist(next);
    return nextJob;
  }

  private async get(): Promise<LocalSttJobData> {
    if (this.cache) {
      return this.cache;
    }

    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.cache = LocalSttJobDataSchema.parse(JSON.parse(raw));
      return this.cache;
    } catch {
      this.cache = DEFAULT_STT_JOB_DATA;
      await this.persist(this.cache);
      return this.cache;
    }
  }

  private async persist(data: LocalSttJobData): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }
}

export const localSttJobStore = new LocalSttJobStore();

function defaultUserDataPath(): string {
  return process.env.SALES_TALK_USER_DATA_PATH ?? app?.getPath?.('userData') ?? process.cwd();
}
