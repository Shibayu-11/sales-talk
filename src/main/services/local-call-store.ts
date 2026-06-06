import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { CallSessionSchema } from '@shared/schemas';
import type {
  CallSession,
  Industry,
  MeetingSource,
  ProductId,
  RecordingConsent,
} from '@shared/types';

const LocalCallDataSchema = z.object({
  calls: z.array(CallSessionSchema),
});

interface LocalCallData {
  calls: CallSession[];
}

const DEFAULT_CALL_DATA: LocalCallData = {
  calls: [],
};

export class LocalCallStore {
  private cache: LocalCallData | null = null;

  constructor(private readonly filePath = join(defaultUserDataPath(), 'local-calls.json')) {}

  async createCall(input: {
    tenantId: string;
    organizationId: string;
    source: MeetingSource;
    industry: Industry;
    productId: ProductId;
    recordingConsent: RecordingConsent;
    startedAt?: Date | undefined;
  }): Promise<CallSession> {
    const now = new Date().toISOString();
    const startedAt = input.startedAt?.toISOString() ?? now;
    const call: CallSession = {
      id: randomUUID(),
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      source: input.source,
      industry: input.industry,
      productId: input.productId,
      recordingConsent: input.recordingConsent,
      status: 'active',
      startedAt,
      endedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const data = await this.get();
    const next = { calls: [call, ...data.calls] };
    this.cache = next;
    await this.persist(next);
    return call;
  }

  async endCall(id: string, endedAt: Date = new Date()): Promise<CallSession> {
    const data = await this.get();
    const call = data.calls.find((candidate) => candidate.id === id);
    if (!call) {
      throw new Error('Call was not found');
    }

    const now = new Date().toISOString();
    const nextCall: CallSession = {
      ...call,
      status: 'ended',
      endedAt: endedAt.toISOString(),
      updatedAt: now,
    };
    const next = {
      calls: data.calls.map((candidate) => (candidate.id === id ? nextCall : candidate)),
    };
    this.cache = next;
    await this.persist(next);
    return nextCall;
  }

  async listCalls(): Promise<CallSession[]> {
    return (await this.get()).calls;
  }

  private async get(): Promise<LocalCallData> {
    if (this.cache) {
      return this.cache;
    }

    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.cache = LocalCallDataSchema.parse(JSON.parse(raw));
      return this.cache;
    } catch {
      this.cache = DEFAULT_CALL_DATA;
      await this.persist(this.cache);
      return this.cache;
    }
  }

  private async persist(data: LocalCallData): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }
}

export const localCallStore = new LocalCallStore();

function defaultUserDataPath(): string {
  return process.env.SALES_TALK_USER_DATA_PATH ?? app?.getPath?.('userData') ?? process.cwd();
}
