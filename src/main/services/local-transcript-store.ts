import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { TranscriptSegmentSchema } from '@shared/schemas';
import type { Transcript, TranscriptSegment } from '@shared/types';

const LocalTranscriptDataSchema = z.object({
  segments: z.array(TranscriptSegmentSchema),
});

interface LocalTranscriptData {
  segments: TranscriptSegment[];
}

const DEFAULT_TRANSCRIPT_DATA: LocalTranscriptData = {
  segments: [],
};

export class LocalTranscriptStore {
  private cache: LocalTranscriptData | null = null;

  constructor(private readonly filePath = join(defaultUserDataPath(), 'local-transcripts.json')) {}

  async appendTranscript(callId: string, transcript: Transcript): Promise<TranscriptSegment> {
    const segment: TranscriptSegment = {
      id: randomUUID(),
      callId,
      speaker: transcript.speaker,
      text: transcript.text,
      isFinal: transcript.isFinal,
      startMs: transcript.startMs,
      endMs: transcript.isFinal ? transcript.endMs : null,
      createdAt: new Date().toISOString(),
    };
    const data = await this.get();
    const next = { segments: [...data.segments, segment] };
    this.cache = next;
    await this.persist(next);
    return segment;
  }

  async listTranscripts(callId: string): Promise<TranscriptSegment[]> {
    const data = await this.get();
    return data.segments.filter((segment) => segment.callId === callId);
  }

  private async get(): Promise<LocalTranscriptData> {
    if (this.cache) {
      return this.cache;
    }

    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.cache = LocalTranscriptDataSchema.parse(JSON.parse(raw));
      return this.cache;
    } catch {
      this.cache = DEFAULT_TRANSCRIPT_DATA;
      await this.persist(this.cache);
      return this.cache;
    }
  }

  private async persist(data: LocalTranscriptData): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }
}

export const localTranscriptStore = new LocalTranscriptStore();

function defaultUserDataPath(): string {
  return process.env.SALES_TALK_USER_DATA_PATH ?? app?.getPath?.('userData') ?? process.cwd();
}
