import { describe, expect, it, vi } from 'vitest';
import { AudioSttJobRunner } from '../../src/main/services/audio-stt-job-runner';
import type {
  AppRepositories,
  AudioAssetRepository,
  AudioSttJobRepository,
  TranscriptRepository,
} from '../../src/main/services/repositories';
import type { AudioAsset, AudioSttJob, Transcript } from '../../src/shared/types';

const callId = 'ce710872-1efd-4965-8ca4-e4d13f810250';
const audioAssetId = 'e3aa5d3e-6f23-4f3c-bfc6-b0453eaa4ff3';
const jobId = '442db17c-6a3c-4e7e-856b-b11a4c1eab24';

describe('AudioSttJobRunner', () => {
  it('marks a job completed and persists transcripts', async () => {
    const appendedTranscripts: Transcript[] = [];
    const transcripts: Transcript[] = [
      {
        speaker: 'counterpart',
        text: 'この商品は絶対儲かります。',
        isFinal: true,
        startMs: 0,
        endMs: 1_000,
      },
    ];
    const repositories = createRepositories({
      appendTranscript: async (_callId, transcript) => {
        appendedTranscripts.push(transcript);
      },
    });
    const onCompleted = vi.fn(async () => undefined);
    const runner = new AudioSttJobRunner({
      repositories,
      transcribeAudio: vi.fn(async () => transcripts),
      onCompleted,
    });

    await expect(runner.run(jobId)).resolves.toMatchObject({ id: jobId, status: 'completed' });
    expect(appendedTranscripts).toMatchObject([
      {
        text: 'この商品は絶対儲かります。',
        isFinal: true,
      },
    ]);
    expect(onCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ id: jobId, status: 'completed' }),
      transcripts,
    );
  });

  it('marks a job failed when transcription fails', async () => {
    const repositories = createRepositories();
    const runner = new AudioSttJobRunner({
      repositories,
      transcribeAudio: vi.fn(async () => {
        throw new Error('missing key');
      }),
    });

    await expect(runner.run(jobId)).resolves.toMatchObject({
      id: jobId,
      status: 'failed',
      errorMessage: 'missing key',
    });
  });
});

function createRepositories(options: {
  appendTranscript?: ((callId: string, transcript: Transcript) => Promise<void>) | undefined;
} = {}): AppRepositories {
  const job: AudioSttJob = {
    id: jobId,
    callId,
    audioAssetId,
    provider: 'deepgram',
    status: 'queued',
    errorMessage: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
  };
  const asset: AudioAsset = {
    id: audioAssetId,
    callId,
    fileName: 'sample.m4a',
    originalPath: '/tmp/sample.m4a',
    storedPath: '/tmp/stored.m4a',
    mimeType: 'audio/mp4',
    sizeBytes: 10,
    createdAt: '2026-06-01T00:00:00.000Z',
  };

  const sttJobs: AudioSttJobRepository = {
    createJob: vi.fn(async () => job),
    listJobs: vi.fn(async () => [job]),
    getJob: vi.fn(async () => job),
    updateJobStatus: vi.fn(async (_id, status, errorMessage = null) => ({
      ...job,
      status,
      errorMessage,
    })),
  };
  const audioAssets: AudioAssetRepository = {
    importAudioFile: vi.fn(async () => asset),
    listAudioAssets: vi.fn(async () => [asset]),
  };
  const transcripts: TranscriptRepository = {
    appendTranscript: vi.fn(async (targetCallId, transcript) => {
      await options.appendTranscript?.(targetCallId, transcript);
      return {
        id: '19050688-f1c7-4f98-ae3d-a539947cf65e',
        callId: targetCallId,
        speaker: transcript.speaker,
        text: transcript.text,
        isFinal: transcript.isFinal,
        startMs: transcript.startMs,
        endMs: transcript.isFinal ? transcript.endMs : null,
        createdAt: '2026-06-01T00:00:00.000Z',
      };
    }),
    listTranscripts: vi.fn(async () => []),
  };

  return {
    organizations: {
      getDefaultScope: vi.fn(async () => ({
        tenantId: '00000000-0000-4000-8000-000000000001',
        organizationId: '00000000-0000-4000-8000-000000000002',
      })),
      getCurrentContext: vi.fn(async () => {
        throw new Error('not used');
      }),
      listOrganizations: vi.fn(async () => []),
      listUsers: vi.fn(async () => []),
      updateUserRole: vi.fn(async () => {
        throw new Error('not used');
      }),
      assertPermission: vi.fn(async () => {
        throw new Error('not used');
      }),
    },
    calls: {
      createCall: vi.fn(),
      endCall: vi.fn(),
      listCalls: vi.fn(),
    },
    transcripts,
    audioAssets,
    sttJobs,
    knowledge: {
      list: vi.fn(),
      search: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    minutes: {
      getLatestMeetingMinute: vi.fn(),
      setLatestMeetingMinute: vi.fn(),
    },
    tasks: {
      listTasks: vi.fn(),
      createTask: vi.fn(),
      completeTask: vi.fn(),
    },
    reviews: {
      listReviewTasks: vi.fn(),
      createReviewTasks: vi.fn(),
      updateReviewTaskStatus: vi.fn(),
    },
    auditLogs: {
      appendAuditLogs: vi.fn(),
      listAuditLogs: vi.fn(async () => []),
    },
    complianceRules: {
      listRules: vi.fn(),
      createRule: vi.fn(),
      deleteRule: vi.fn(),
    },
  };
}
