import { describe, expect, it, vi } from 'vitest';
import { AudioSttJobRunner } from '../../src/main/services/audio-stt-job-runner';
import type {
  AppRepositories,
  AudioAssetRepository,
  AudioSttJobRepository,
  TranscriptRepository,
} from '../../src/main/services/repositories';
import type { AudioAsset, AudioSttJob, Transcript } from '../../src/shared/types';
import { AppleSpeechAnalyzerBatchTranscriber } from '../../src/main/services/apple-speech-analyzer-batch';

const callId = 'ce710872-1efd-4965-8ca4-e4d13f810250';
const audioAssetId = 'e3aa5d3e-6f23-4f3c-bfc6-b0453eaa4ff3';
const jobId = '442db17c-6a3c-4e7e-856b-b11a4c1eab24';

describe('AudioSttJobRunner', () => {
  it('marks a job completed and persists transcripts', async () => {
    const appendedTranscripts: Transcript[] = [];
    const cleanup = vi.fn(async () => undefined);
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
      materializedPath: '/tmp/readable-sample.m4a',
      cleanup,
    });
    const transcribeAudio = vi.fn(async (asset: AudioAsset) => {
      expect(asset.storedPath).toBe('/tmp/readable-sample.m4a');
      return transcripts;
    });
    const onCompleted = vi.fn(async () => undefined);
    const runner = new AudioSttJobRunner({
      repositories,
      transcribeAudio,
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
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('marks a job failed when transcription fails', async () => {
    const cleanup = vi.fn(async () => undefined);
    const repositories = createRepositories({ cleanup });
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
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe('AudioSttJobRunner — import provider resolution', () => {
  it('uses Apple batch transcriber when local_first and helper is available', async () => {
    const transcript: Transcript = {
      speaker: 'counterpart',
      text: '価格が高い',
      isFinal: true,
      startMs: 0,
      endMs: 500,
    };
    const appleTranscriber = {
      isAvailable: vi.fn(() => true),
      transcribeFile: vi.fn(async () => [transcript]),
    } as unknown as AppleSpeechAnalyzerBatchTranscriber;

    const repositories = createRepositories();
    const runner = new AudioSttJobRunner({
      repositories,
      importProviderMode: 'local_first',
      importResolverOptions: {
        createAppleBatchTranscriber: () => appleTranscriber,
      },
    });

    const result = await runner.run(jobId);
    expect(result.status).toBe('completed');
    expect(appleTranscriber.transcribeFile).toHaveBeenCalledWith(
      expect.objectContaining({ storedPath: '/tmp/materialized-sample.m4a' }),
    );
  });

  it('falls back to Deepgram when local_first and helper is unavailable', async () => {
    const transcript: Transcript = {
      speaker: 'counterpart',
      text: '考えます',
      isFinal: true,
      startMs: 0,
      endMs: 200,
    };
    const appleTranscriber = {
      isAvailable: vi.fn(() => false),
      transcribeFile: vi.fn(),
    } as unknown as AppleSpeechAnalyzerBatchTranscriber;
    const deepgramTranscribe = vi.fn(async () => [transcript]);

    const repositories = createRepositories();
    const runner = new AudioSttJobRunner({
      repositories,
      importProviderMode: 'local_first',
      importResolverOptions: {
        createAppleBatchTranscriber: () => appleTranscriber,
        deepgramTranscribe,
      },
    });

    const result = await runner.run(jobId);
    expect(result.status).toBe('completed');
    expect(deepgramTranscribe).toHaveBeenCalled();
    expect(appleTranscriber.transcribeFile).not.toHaveBeenCalled();
  });

  it('resolveImportProvider returns correct kind and degradedReason', () => {
    const appleTranscriber = {
      isAvailable: vi.fn(() => false),
      transcribeFile: vi.fn(),
    } as unknown as AppleSpeechAnalyzerBatchTranscriber;

    const runner = new AudioSttJobRunner({
      repositories: createRepositories(),
      importProviderMode: 'local_first',
      importResolverOptions: {
        createAppleBatchTranscriber: () => appleTranscriber,
      },
    });

    const resolved = runner.resolveImportProvider();
    expect(resolved.kind).toBe('deepgram');
    expect(resolved.degradedReason).toBe('apple_speech_analyzer_unavailable');
  });

  it('injectable transcribeAudio still takes precedence over resolver', async () => {
    const injectableTranscript: Transcript = {
      speaker: 'counterpart',
      text: 'injected',
      isFinal: true,
      startMs: 0,
      endMs: 100,
    };
    const appleTranscriber = {
      isAvailable: vi.fn(() => true),
      transcribeFile: vi.fn(),
    } as unknown as AppleSpeechAnalyzerBatchTranscriber;

    const repositories = createRepositories();
    const runner = new AudioSttJobRunner({
      repositories,
      transcribeAudio: vi.fn(async () => [injectableTranscript]),
      importProviderMode: 'local_first',
      importResolverOptions: {
        createAppleBatchTranscriber: () => appleTranscriber,
      },
    });

    await runner.run(jobId);
    // Apple transcriber should NOT be called — injectable takes precedence
    expect(appleTranscriber.transcribeFile).not.toHaveBeenCalled();
  });
});

function createRepositories(options: {
  appendTranscript?: ((callId: string, transcript: Transcript) => Promise<void>) | undefined;
  materializedPath?: string | undefined;
  cleanup?: (() => Promise<void>) | undefined;
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
    materializeReadableAsset: vi.fn(async (targetAsset) => ({
      asset: targetAsset,
      filePath: options.materializedPath ?? '/tmp/materialized-sample.m4a',
      cleanup: options.cleanup ?? vi.fn(async () => undefined),
    })),
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
      verifyAuditLogs: vi.fn(async () => ({
        valid: true,
        checkedEntries: 0,
        invalidEntryId: null,
      })),
    },
    complianceRules: {
      listRules: vi.fn(),
      listRuleSets: vi.fn(),
      listRulesForSet: vi.fn(),
      createRuleSet: vi.fn(),
      setRuleSetActive: vi.fn(),
      submitRuleSet: vi.fn(),
      reviewRuleSet: vi.fn(),
      createRuleSetRevision: vi.fn(),
      createRule: vi.fn(),
      updateRule: vi.fn(),
      deleteRule: vi.fn(),
    },
  };
}
