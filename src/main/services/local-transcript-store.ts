import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { TranscriptRevisionSchema, TranscriptSegmentSchema } from '@shared/schemas';
import type { AudioSttProvider, Transcript, TranscriptRevision, TranscriptSegment } from '@shared/types';
import { writeFileAtomic } from './atomic-file';

const LocalTranscriptDataSchema = z.object({
  segments: z.array(TranscriptSegmentSchema),
  revisions: z.array(TranscriptRevisionSchema).default([]),
  activeRevisionByCallId: z.record(z.string().uuid()).default({}),
});

type LocalTranscriptData = z.infer<typeof LocalTranscriptDataSchema>;

function createDefaultTranscriptData(): LocalTranscriptData {
  return {
    segments: [],
    revisions: [],
    activeRevisionByCallId: {},
  };
}

export class LocalTranscriptStore {
  private cache: LocalTranscriptData | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = join(defaultUserDataPath(), 'local-transcripts.json')) {}

  async appendTranscript(callId: string, transcript: Transcript): Promise<TranscriptSegment> {
    return this.mutate(async (data) => {
      const { next: revisionData, revision } = ensureLiveOriginalRevision(data, callId);
      const segment = createTranscriptSegment({
        callId,
        revisionId: revision.id,
        sourceJobId: null,
        transcript,
      });
      const next = recalculateSegmentCounts({
        ...revisionData,
        segments: [...revisionData.segments, segment],
      });
      return { next, result: segment };
    });
  }

  async listTranscripts(
    callId: string,
    revisionId?: string | undefined,
  ): Promise<TranscriptSegment[]> {
    const data = await this.get();
    const targetRevisionId = revisionId ?? data.activeRevisionByCallId[callId];
    if (!targetRevisionId) {
      return [];
    }
    return data.segments.filter(
      (segment) => segment.callId === callId && segment.revisionId === targetRevisionId,
    );
  }

  async commitRevision(input: {
    callId: string;
    sttJobId: string;
    audioAssetId: string;
    provider: AudioSttProvider;
    reason: string;
    transcripts: Transcript[];
  }): Promise<TranscriptRevision> {
    return this.mutate(async (data) => {
      const existing = data.revisions.find((revision) => revision.sttJobId === input.sttJobId);
      if (existing) {
        return { next: data, result: this.withActiveState(data, existing) };
      }

      const { next: revisionData } = ensureLiveOriginalRevision(data, input.callId);
      const now = new Date().toISOString();
      const activeRevisionId = revisionData.activeRevisionByCallId[input.callId] ?? null;
      const revision: TranscriptRevision = {
        id: randomUUID(),
        callId: input.callId,
        origin: 'audio_import',
        parentRevisionId: activeRevisionId,
        audioAssetId: input.audioAssetId,
        sttJobId: input.sttJobId,
        provider: input.provider,
        revisionNumber: nextRevisionNumber(revisionData, input.callId),
        reason: input.reason,
        segmentCount: input.transcripts.length,
        active: false,
        createdAt: now,
      };
      const segments = input.transcripts.map((transcript) =>
        createTranscriptSegment({
          callId: input.callId,
          revisionId: revision.id,
          sourceJobId: input.sttJobId,
          transcript,
          createdAt: now,
        }),
      );
      return {
        next: {
          ...revisionData,
          revisions: [revision, ...revisionData.revisions],
          segments: [...revisionData.segments, ...segments],
        },
        result: revision,
      };
    });
  }

  async listRevisions(callId: string): Promise<TranscriptRevision[]> {
    const data = await this.get();
    return data.revisions
      .filter((revision) => revision.callId === callId)
      .sort((left, right) => left.revisionNumber - right.revisionNumber)
      .map((revision) => this.withActiveState(data, revision));
  }

  async activateRevision(
    callId: string,
    revisionId: string,
    expectedActiveRevisionId?: string | null | undefined,
  ): Promise<TranscriptRevision> {
    return this.mutate(async (data) => {
      const revision = data.revisions.find(
        (candidate) => candidate.callId === callId && candidate.id === revisionId,
      );
      if (!revision) {
        throw new Error('Transcript revision was not found');
      }
      if (
        expectedActiveRevisionId !== undefined &&
        (data.activeRevisionByCallId[callId] ?? null) !== expectedActiveRevisionId
      ) {
        throw new Error('Active transcript revision changed during processing');
      }

      const next = {
        ...data,
        activeRevisionByCallId: {
          ...data.activeRevisionByCallId,
          [callId]: revisionId,
        },
      };
      return { next, result: this.withActiveState(next, revision) };
    });
  }

  private withActiveState(
    data: LocalTranscriptData,
    revision: TranscriptRevision,
  ): TranscriptRevision {
    return {
      ...revision,
      active: data.activeRevisionByCallId[revision.callId] === revision.id,
    };
  }

  private async get(): Promise<LocalTranscriptData> {
    if (this.cache) {
      return this.cache;
    }

    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = LocalTranscriptDataSchema.parse(JSON.parse(raw));
      const migrated = migrateLegacyOriginalRevisions(parsed);
      if (migrated !== parsed) {
        await this.persist(migrated);
      }
      this.cache = migrated;
      return this.cache;
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        throw error;
      }
      const initialized = createDefaultTranscriptData();
      await this.persist(initialized);
      this.cache = initialized;
      return this.cache;
    }
  }

  private mutate<T>(
    operation: (data: LocalTranscriptData) => Promise<{ next: LocalTranscriptData; result: T }>,
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

  private async persist(data: LocalTranscriptData): Promise<void> {
    await writeFileAtomic(this.filePath, `${JSON.stringify(data, null, 2)}\n`);
  }
}

export const localTranscriptStore = new LocalTranscriptStore();

function defaultUserDataPath(): string {
  return process.env.SALES_TALK_USER_DATA_PATH ?? app?.getPath?.('userData') ?? process.cwd();
}

function createTranscriptSegment(input: {
  callId: string;
  revisionId: string;
  sourceJobId: string | null;
  transcript: Transcript;
  createdAt?: string | undefined;
}): TranscriptSegment {
  return {
    id: randomUUID(),
    callId: input.callId,
    revisionId: input.revisionId,
    sourceJobId: input.sourceJobId,
    speaker: input.transcript.speaker,
    text: input.transcript.text,
    isFinal: input.transcript.isFinal,
    startMs: input.transcript.startMs,
    endMs: input.transcript.isFinal ? input.transcript.endMs : null,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

function ensureLiveOriginalRevision(
  data: LocalTranscriptData,
  callId: string,
): { next: LocalTranscriptData; revision: TranscriptRevision } {
  const existing = data.revisions.find(
    (revision) => revision.callId === callId && revision.origin === 'live',
  );
  if (existing) {
    if (data.activeRevisionByCallId[callId]) {
      return { next: data, revision: existing };
    }
    return {
      next: {
        ...data,
        activeRevisionByCallId: {
          ...data.activeRevisionByCallId,
          [callId]: existing.id,
        },
      },
      revision: existing,
    };
  }

  const now = new Date().toISOString();
  const revision: TranscriptRevision = {
    id: randomUUID(),
    callId,
    origin: 'live',
    parentRevisionId: null,
    audioAssetId: null,
    sttJobId: null,
    provider: null,
    revisionNumber: nextRevisionNumber(data, callId),
    reason: 'original_live_transcript',
    segmentCount: 0,
    active: false,
    createdAt: now,
  };
  return {
    next: {
      ...data,
      revisions: [revision, ...data.revisions],
      activeRevisionByCallId: {
        ...data.activeRevisionByCallId,
        [callId]: revision.id,
      },
    },
    revision,
  };
}

function migrateLegacyOriginalRevisions(data: LocalTranscriptData): LocalTranscriptData {
  const legacyCallIds = Array.from(
    new Set(
      data.segments
        .filter((segment) => segment.revisionId === null)
        .map((segment) => segment.callId),
    ),
  );
  const missingLiveCallIds = Array.from(
    new Set(
      data.segments
        .map((segment) => segment.callId)
        .filter(
          (callId) =>
            !data.revisions.some(
              (revision) => revision.callId === callId && revision.origin === 'live',
            ),
        ),
    ),
  );
  const callIds = Array.from(new Set([...legacyCallIds, ...missingLiveCallIds]));
  if (callIds.length === 0) {
    return data;
  }

  let next = data;
  for (const callId of callIds) {
    const ensured = ensureLiveOriginalRevision(next, callId);
    next = ensured.next;
    next = {
      ...next,
      segments: next.segments.map((segment) => {
        if (segment.callId !== callId || segment.revisionId !== null) {
          return segment;
        }
        return {
          ...segment,
          revisionId: ensured.revision.id,
        };
      }),
    };
  }
  return recalculateSegmentCounts(next);
}

function recalculateSegmentCounts(data: LocalTranscriptData): LocalTranscriptData {
  return {
    ...data,
    revisions: data.revisions.map((revision) => ({
      ...revision,
      segmentCount: data.segments.filter((segment) => segment.revisionId === revision.id).length,
    })),
  };
}

function nextRevisionNumber(data: LocalTranscriptData, callId: string): number {
  const maxRevisionNumber = data.revisions
    .filter((revision) => revision.callId === callId)
    .reduce((max, revision) => Math.max(max, revision.revisionNumber), 0);
  return maxRevisionNumber + 1;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
