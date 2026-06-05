import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { AudioAsset, AudioSttJob, Transcript } from '@shared/types';
import type { AppRepositories } from './repositories';
import { secretStore } from './secrets';

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
  transcribeAudio?: ((asset: AudioAsset) => Promise<Transcript[]>) | undefined;
}

export class AudioSttJobRunner {
  constructor(private readonly options: AudioSttJobRunnerOptions) {}

  async run(jobId: string): Promise<AudioSttJob> {
    const job = await this.options.repositories.sttJobs.getJob(jobId);
    if (!job) {
      throw new Error('STT job was not found');
    }

    await this.options.repositories.sttJobs.updateJobStatus(job.id, 'running');

    try {
      const asset = await this.findAudioAsset(job);
      const transcripts = await this.transcribe(asset);
      for (const transcript of transcripts) {
        await this.options.repositories.transcripts.appendTranscript(job.callId, transcript);
      }

      return this.options.repositories.sttJobs.updateJobStatus(job.id, 'completed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.options.repositories.sttJobs.updateJobStatus(job.id, 'failed', message);
    }
  }

  private async findAudioAsset(job: AudioSttJob): Promise<AudioAsset> {
    const assets = await this.options.repositories.audioAssets.listAudioAssets(job.callId);
    const asset = assets.find((candidate) => candidate.id === job.audioAssetId);
    if (!asset) {
      throw new Error('Audio asset was not found');
    }
    return asset;
  }

  private async transcribe(asset: AudioAsset): Promise<Transcript[]> {
    if (this.options.transcribeAudio) {
      return this.options.transcribeAudio(asset);
    }

    return transcribeAudioWithDeepgram(asset);
  }
}

export async function transcribeAudioWithDeepgram(asset: AudioAsset): Promise<Transcript[]> {
  const apiKey = (await secretStore.get('deepgram_api_key')) ?? process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    throw new Error('Deepgram API key is not configured');
  }

  const audio = await readFile(asset.storedPath);
  const response = await fetch(buildDeepgramPrerecordedUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': asset.mimeType,
    },
    body: audio,
  });

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

function buildDeepgramPrerecordedUrl(): string {
  const url = new URL(DEEPGRAM_PRERECORDED_URL);
  url.searchParams.set('model', process.env.DEEPGRAM_MODEL ?? DEEPGRAM_MODEL);
  url.searchParams.set('language', DEEPGRAM_LANGUAGE);
  url.searchParams.set('punctuate', 'true');
  url.searchParams.set('smart_format', 'true');
  return url.toString();
}
