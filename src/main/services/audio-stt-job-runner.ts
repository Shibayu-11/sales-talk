import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type {
  AudioAsset,
  AudioSttJob,
  AudioSttProvider,
  SttImportProviderMode,
  Transcript,
  TranscriptRevision,
} from '@shared/types';
import type { AppRepositories } from './repositories';
import { secretStore } from './secrets';
import { resolveImportSTTProvider, resolveRecordedImportSTTProvider } from './import-stt-provider-resolver';
import type { ImportSTTProviderResolverOptions } from './import-stt-provider-resolver';

const DEEPGRAM_PRERECORDED_URL = 'https://api.deepgram.com/v1/listen';
const DEEPGRAM_MODEL = 'nova-3';
const DEEPGRAM_LANGUAGE = 'ja';

const DeepgramPrerecordedResponseSchema = z.object({
  results: z.object({
    channels: z
      .array(
        z.object({
          alternatives: z
            .array(
              z.object({
                transcript: z.string().default(''),
              }),
            )
            .min(1),
        }),
      )
      .min(1),
  }),
});

export interface AudioSttJobRunnerOptions {
  repositories: AppRepositories;
  /** Injectable override for tests; when set, bypasses provider resolution entirely. */
  transcribeAudio?:
    | ((asset: AudioAsset, signal?: AbortSignal | undefined) => Promise<Transcript[]>)
    | undefined;
  onRevisionReady?:
    | ((
        job: AudioSttJob,
        revision: TranscriptRevision,
        transcripts: Transcript[],
      ) => Promise<void>)
    | undefined;
  onActivated?:
    | ((job: AudioSttJob, transcripts: Transcript[], revision: TranscriptRevision) => Promise<void>)
    | undefined;
  /** Import provider mode; defaults to 'local_first'. */
  importProviderMode?: SttImportProviderMode | undefined;
  /** Injectable factory overrides for the import resolver (for tests). */
  importResolverOptions?: Partial<ImportSTTProviderResolverOptions> | undefined;
}

export class AudioSttJobRunner {
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(private readonly options: AudioSttJobRunnerOptions) {}

  async run(jobId: string): Promise<AudioSttJob> {
    const runToken = randomUUID();
    const claimedJob = await this.options.repositories.sttJobs.claimQueued(jobId, runToken);
    if (claimedJob.status === 'cancelled') {
      return claimedJob;
    }

    const abortController = new AbortController();
    this.abortControllers.set(jobId, abortController);
    try {
      const asset = await this.findAudioAsset(claimedJob);
      const preparedJob = await this.options.repositories.sttJobs.updateProgress(jobId, runToken, 25);
      if (preparedJob.status === 'cancelled') {
        return preparedJob;
      }
      throwIfAborted(abortController.signal);

      const transcripts = await this.transcribe(asset, claimedJob.provider, abortController.signal);
      const transcribedJob = await this.options.repositories.sttJobs.updateProgress(
        jobId,
        runToken,
        70,
      );
      if (transcribedJob.status === 'cancelled') {
        return transcribedJob;
      }
      throwIfAborted(abortController.signal);

      const revision = await this.options.repositories.transcripts.commitRevision({
        callId: claimedJob.callId,
        sttJobId: claimedJob.id,
        audioAssetId: claimedJob.audioAssetId,
        provider: claimedJob.provider,
        reason: claimedJob.retryReason ?? 'initial_transcription',
        transcripts,
      });
      const committedJob = await this.options.repositories.sttJobs.updateProgress(
        jobId,
        runToken,
        85,
      );
      if (committedJob.status === 'cancelled') {
        return committedJob;
      }
      throwIfAborted(abortController.signal);

      try {
        await this.options.onRevisionReady?.(claimedJob, revision, transcripts);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return await this.options.repositories.sttJobs.failJob({
          id: jobId,
          runToken,
          errorMessage: message,
          transcriptRevisionId: revision.id,
        });
      }

      const readyJob = await this.options.repositories.sttJobs.updateProgress(jobId, runToken, 90);
      if (readyJob.status === 'cancelled') {
        return readyJob;
      }
      throwIfAborted(abortController.signal);

      await this.options.repositories.transcripts.activateRevision(
        claimedJob.callId,
        revision.id,
        revision.parentRevisionId,
      );
      try {
        await this.options.onActivated?.(readyJob, transcripts, revision);
      } catch (error) {
        if (revision.parentRevisionId) {
          await this.options.repositories.transcripts.activateRevision(
            claimedJob.callId,
            revision.parentRevisionId,
            revision.id,
          );
        }
        const message = error instanceof Error ? error.message : String(error);
        return await this.options.repositories.sttJobs.failJob({
          id: jobId,
          runToken,
          errorMessage: message,
          transcriptRevisionId: revision.id,
        });
      }
      const completedJob = await this.options.repositories.sttJobs.completeJob({
        id: jobId,
        runToken,
        transcriptRevisionId: revision.id,
      });
      return completedJob;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.options.repositories.sttJobs.failJob({
        id: jobId,
        runToken,
        errorMessage: message,
      });
    } finally {
      if (this.abortControllers.get(jobId) === abortController) {
        this.abortControllers.delete(jobId);
      }
    }
  }

  async cancel(jobId: string): Promise<AudioSttJob> {
    const cancelledJob = await this.options.repositories.sttJobs.requestCancel(jobId);
    if (cancelledJob.status === 'cancelled') {
      this.abortControllers.get(jobId)?.abort();
    }
    return cancelledJob;
  }

  /**
   * Returns the resolved import provider without running a job.
   * Used by IPC to record the chosen provider in the audit log before job creation.
   */
  resolveImportProvider(): { kind: AudioSttProvider; degradedReason?: string | undefined } {
    const mode = this.options.importProviderMode ?? 'local_first';
    const resolved = resolveImportSTTProvider({
      mode,
      ...this.options.importResolverOptions,
    });
    return { kind: resolved.kind, degradedReason: resolved.degradedReason };
  }

  private async findAudioAsset(job: AudioSttJob): Promise<AudioAsset> {
    const assets = await this.options.repositories.audioAssets.listAudioAssets(job.callId);
    const asset = assets.find((candidate) => candidate.id === job.audioAssetId);
    if (!asset) {
      throw new Error('Audio asset was not found');
    }
    return asset;
  }

  private async transcribe(
    asset: AudioAsset,
    provider: AudioSttProvider,
    signal: AbortSignal,
  ): Promise<Transcript[]> {
    const lease = await this.options.repositories.audioAssets.materializeReadableAsset(asset);
    const readableAsset: AudioAsset = { ...asset, storedPath: lease.filePath };
    try {
      // Injectable override for tests takes precedence.
      if (this.options.transcribeAudio) {
        return await this.options.transcribeAudio(readableAsset, signal);
      }

      const resolved = resolveRecordedImportSTTProvider({
        provider,
        ...this.options.importResolverOptions,
      });
      return await resolved.transcriber.transcribeFile(readableAsset, signal);
    } finally {
      await lease.cleanup();
    }
  }
}

export async function transcribeAudioWithDeepgram(
  asset: AudioAsset,
  signal?: AbortSignal | undefined,
): Promise<Transcript[]> {
  const apiKey = (await secretStore.get('deepgram_api_key')) ?? process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    throw new Error('Deepgram API key is not configured');
  }

  const audio = await readFile(asset.storedPath);
  const requestInit: RequestInit = {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': asset.mimeType,
    },
    body: audio,
  };
  if (signal) {
    requestInit.signal = signal;
  }
  const response = await fetch(buildDeepgramPrerecordedUrl(), requestInit);

  if (!response.ok) {
    throw new Error(`Deepgram prerecorded STT failed: ${response.status}`);
  }

  const parsed = DeepgramPrerecordedResponseSchema.parse(await response.json());
  const text = parsed.results.channels[0]?.alternatives[0]?.transcript.trim() ?? '';
  if (!text) {
    return [];
  }

  return [
    {
      speaker: 'counterpart',
      text,
      isFinal: true,
      startMs: 0,
      endMs: 0,
    },
  ];
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }
  const error = new Error('STT transcription was aborted');
  error.name = 'AbortError';
  throw error;
}

function buildDeepgramPrerecordedUrl(): string {
  const url = new URL(DEEPGRAM_PRERECORDED_URL);
  url.searchParams.set('model', process.env.DEEPGRAM_MODEL ?? DEEPGRAM_MODEL);
  url.searchParams.set('language', DEEPGRAM_LANGUAGE);
  url.searchParams.set('punctuate', 'true');
  url.searchParams.set('smart_format', 'true');
  return url.toString();
}
