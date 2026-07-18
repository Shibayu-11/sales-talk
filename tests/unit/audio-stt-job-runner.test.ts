import { describe, expect, it, vi } from 'vitest';
import { AudioSttJobRunner } from '../../src/main/services/audio-stt-job-runner';
import type {
  AppRepositories,
  AudioAssetRepository,
  AudioSttJobRepository,
  TranscriptRepository,
} from '../../src/main/services/repositories';
import type { AudioAsset, AudioSttJob, Transcript, TranscriptRevision } from '../../src/shared/types';
import { AppleSpeechAnalyzerBatchTranscriber } from '../../src/main/services/apple-speech-analyzer-batch';

const callId = 'ce710872-1efd-4965-8ca4-e4d13f810250';
const audioAssetId = 'e3aa5d3e-6f23-4f3c-bfc6-b0453eaa4ff3';
const jobId = '442db17c-6a3c-4e7e-856b-b11a4c1eab24';
const revisionId = '19050688-f1c7-4f98-ae3d-a539947cf65e';
const originalRevisionId = '29050688-f1c7-4f98-ae3d-a539947cf65e';

describe('AudioSttJobRunner', () => {
  it('marks a queued job completed after committing and activating a revision', async () => {
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
      materializedPath: '/tmp/readable-sample.m4a',
      cleanup,
    });
    const transcribeAudio = vi.fn(async (asset: AudioAsset) => {
      expect(asset.storedPath).toBe('/tmp/readable-sample.m4a');
      return transcripts;
    });
    const onActivated = vi.fn(async () => undefined);
    const runner = new AudioSttJobRunner({
      repositories,
      transcribeAudio,
      onActivated,
    });

    await expect(runner.run(jobId)).resolves.toMatchObject({
      id: jobId,
      status: 'completed',
      progressPercent: 100,
      transcriptRevisionId: revisionId,
    });
    expect(repositories.transcripts.commitRevision).toHaveBeenCalledWith({
      callId,
      sttJobId: jobId,
      audioAssetId,
      provider: 'deepgram',
      reason: 'initial_transcription',
      transcripts,
    });
    expect(repositories.transcripts.activateRevision).toHaveBeenCalledWith(
      callId,
      revisionId,
      originalRevisionId,
    );
    expect(onActivated).toHaveBeenCalledWith(
      expect.objectContaining({ id: jobId, status: 'running', progressPercent: 90 }),
      transcripts,
      expect.objectContaining({ id: revisionId }),
    );
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('marks a job failed when transcription fails unless it was cancelled', async () => {
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

  it('rolls back activation and fails the job when the activation callback fails', async () => {
    const repositories = createRepositories();
    const onActivated = vi.fn(async () => {
      throw new Error('activation audit failed');
    });
    const runner = new AudioSttJobRunner({
      repositories,
      transcribeAudio: vi.fn(async (): Promise<Transcript[]> => [
        finalTranscript('callback boundary'),
      ]),
      onActivated,
    });

    await expect(runner.run(jobId)).resolves.toMatchObject({
      id: jobId,
      status: 'failed',
      transcriptRevisionId: revisionId,
      errorMessage: 'activation audit failed',
    });
    expect(onActivated).toHaveBeenCalledTimes(1);
    expect(repositories.transcripts.activateRevision).toHaveBeenNthCalledWith(
      2,
      callId,
      originalRevisionId,
      revisionId,
    );
    expect(repositories.sttJobs.failJob).toHaveBeenCalledTimes(1);
  });

  it('returns cancelled jobs idempotently without re-running them', async () => {
    const repositories = createRepositories({
      job: { status: 'cancelled', completedAt: '2026-06-01T00:01:00.000Z' },
    });
    const transcribeAudio = vi.fn(async () => []);
    const runner = new AudioSttJobRunner({ repositories, transcribeAudio });

    await expect(runner.run(jobId)).resolves.toMatchObject({ id: jobId, status: 'cancelled' });
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it('rejects non-queued non-cancelled jobs so completed jobs cannot be re-run', async () => {
    const repositories = createRepositories({
      job: { status: 'completed', completedAt: '2026-06-01T00:01:00.000Z' },
    });
    const runner = new AudioSttJobRunner({ repositories });

    await expect(runner.run(jobId)).rejects.toThrow('STT job runner only accepts queued jobs');
    expect(repositories.transcripts.commitRevision).not.toHaveBeenCalled();
  });

  it('does not commit transcripts when cancellation wins after transcription', async () => {
    const repositories = createRepositories({ cancelOnProgressPercent: 70 });
    const runner = new AudioSttJobRunner({
      repositories,
      transcribeAudio: vi.fn(async (): Promise<Transcript[]> => [finalTranscript('cancel me')]),
    });

    await expect(runner.run(jobId)).resolves.toMatchObject({ id: jobId, status: 'cancelled' });
    expect(repositories.transcripts.commitRevision).not.toHaveBeenCalled();
    expect(repositories.transcripts.activateRevision).not.toHaveBeenCalled();
  });

  it('never activates a revision if cancellation wins before activation', async () => {
    const repositories = createRepositories({ cancelOnProgressPercent: 90 });
    const runner = new AudioSttJobRunner({
      repositories,
      transcribeAudio: vi.fn(async (): Promise<Transcript[]> => [
        finalTranscript('committed but cancelled'),
      ]),
    });

    await expect(runner.run(jobId)).resolves.toMatchObject({ id: jobId, status: 'cancelled' });
    expect(repositories.transcripts.commitRevision).toHaveBeenCalledTimes(1);
    expect(repositories.transcripts.activateRevision).not.toHaveBeenCalled();
  });

  it('cancel requests cancellation and aborts the active transcription signal', async () => {
    let capturedSignal: AbortSignal | null = null;
    const repositories = createRepositories();
    const runner = new AudioSttJobRunner({
      repositories,
      transcribeAudio: vi.fn(
        async (_asset: AudioAsset, signal?: AbortSignal | undefined) =>
          new Promise<Transcript[]>((_resolve, reject) => {
            capturedSignal = signal ?? null;
            signal?.addEventListener(
              'abort',
              () => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
              },
              { once: true },
            );
          }),
      ),
    });

    const running = runner.run(jobId);
    await vi.waitUntil(() => capturedSignal !== null);
    await expect(runner.cancel(jobId)).resolves.toMatchObject({ status: 'cancelled' });
    expect((capturedSignal as AbortSignal | null)?.aborted).toBe(true);
    await expect(running).resolves.toMatchObject({ status: 'cancelled' });
  });
});

describe('AudioSttJobRunner — import provider resolution', () => {
  it('uses Apple batch transcriber when the recorded job provider is Apple', async () => {
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

    const repositories = createRepositories({ job: { provider: 'apple_speech_analyzer' } });
    const runner = new AudioSttJobRunner({
      repositories,
      importProviderMode: 'deepgram_only',
      importResolverOptions: {
        createAppleBatchTranscriber: () => appleTranscriber,
      },
    });

    const result = await runner.run(jobId);
    expect(result.status).toBe('completed');
    expect(appleTranscriber.transcribeFile).toHaveBeenCalledWith(
      expect.objectContaining({ storedPath: '/tmp/materialized-sample.m4a' }),
      expect.any(AbortSignal),
    );
  });

  it('uses recorded Deepgram provider even when local Apple helper is available', async () => {
    const transcript: Transcript = {
      speaker: 'counterpart',
      text: '考えます',
      isFinal: true,
      startMs: 0,
      endMs: 200,
    };
    const appleTranscriber = {
      isAvailable: vi.fn(() => true),
      transcribeFile: vi.fn(),
    } as unknown as AppleSpeechAnalyzerBatchTranscriber;
    const deepgramTranscribe = vi.fn(async () => [transcript]);

    const repositories = createRepositories({ job: { provider: 'deepgram' } });
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

    const repositories = createRepositories({ job: { provider: 'apple_speech_analyzer' } });
    const runner = new AudioSttJobRunner({
      repositories,
      transcribeAudio: vi.fn(async () => [injectableTranscript]),
      importProviderMode: 'local_first',
      importResolverOptions: {
        createAppleBatchTranscriber: () => appleTranscriber,
      },
    });

    await runner.run(jobId);
    expect(appleTranscriber.transcribeFile).not.toHaveBeenCalled();
  });
});

function createRepositories(options: {
  job?: Partial<AudioSttJob> | undefined;
  materializedPath?: string | undefined;
  cleanup?: (() => Promise<void>) | undefined;
  cancelOnProgressPercent?: number | undefined;
} = {}): AppRepositories {
  let job: AudioSttJob = {
    id: jobId,
    callId,
    audioAssetId,
    provider: 'deepgram',
    status: 'queued',
    runToken: null,
    progressPercent: 0,
    attempt: 1,
    retryReason: null,
    transcriptRevisionId: null,
    errorMessage: null,
    startedAt: null,
    completedAt: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...options.job,
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
  const revision: TranscriptRevision = {
    id: revisionId,
    callId,
    audioAssetId,
    origin: 'audio_import',
    parentRevisionId: originalRevisionId,
    sttJobId: jobId,
    provider: 'deepgram',
    revisionNumber: 1,
    reason: 'initial_transcription',
    segmentCount: 1,
    active: false,
    createdAt: '2026-06-01T00:00:30.000Z',
  };
  const sttJobs: AudioSttJobRepository = {
    createJob: vi.fn(async () => job),
    listJobs: vi.fn(async () => [job]),
    getJob: vi.fn(async () => job),
    claimQueued: vi.fn(async (_id, runToken) => {
      if (job.status === 'cancelled') {
        return job;
      }
      if (job.status !== 'queued') {
        throw new Error('STT job runner only accepts queued jobs');
      }
      job = {
        ...job,
        status: 'running',
        runToken,
        progressPercent: 10,
        errorMessage: null,
        startedAt: job.startedAt ?? '2026-06-01T00:00:05.000Z',
        completedAt: null,
      };
      return job;
    }),
    updateProgress: vi.fn(async (_id, runToken, progressPercent) => {
      if (job.status === 'cancelled') {
        return job;
      }
      if (options.cancelOnProgressPercent === progressPercent) {
        job = {
          ...job,
          status: 'cancelled',
          runToken: null,
          completedAt: '2026-06-01T00:01:00.000Z',
        };
        return job;
      }
      if (job.status !== 'running' || job.runToken !== runToken) {
        throw new Error('STT job run token is no longer active');
      }
      job = { ...job, progressPercent };
      return job;
    }),
    completeJob: vi.fn(async ({ runToken, transcriptRevisionId }) => {
      if (job.status === 'cancelled') {
        return job;
      }
      if (job.status !== 'running' || job.runToken !== runToken) {
        throw new Error('STT job run token is no longer active');
      }
      job = {
        ...job,
        status: 'completed',
        runToken: null,
        progressPercent: 100,
        transcriptRevisionId,
        completedAt: '2026-06-01T00:01:00.000Z',
      };
      return job;
    }),
    failJob: vi.fn(async ({ runToken, errorMessage, transcriptRevisionId }) => {
      if (job.status === 'cancelled') {
        return job;
      }
      if (job.status !== 'running' || job.runToken !== runToken) {
        throw new Error('STT job run token is no longer active');
      }
      job = {
        ...job,
        status: 'failed',
        runToken: null,
        errorMessage,
        transcriptRevisionId: transcriptRevisionId ?? job.transcriptRevisionId,
        completedAt: '2026-06-01T00:01:00.000Z',
      };
      return job;
    }),
    requestCancel: vi.fn(async () => {
      if (job.status === 'cancelled') {
        return job;
      }
      if (job.status !== 'queued' && job.status !== 'running') {
        throw new Error('STT job cancellation requires a queued or running job');
      }
      job = {
        ...job,
        status: 'cancelled',
        runToken: null,
        completedAt: '2026-06-01T00:01:00.000Z',
      };
      return job;
    }),
    retryJob: vi.fn(async () => job),
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
    appendTranscript: vi.fn(async (targetCallId, transcript) => ({
      id: '39050688-f1c7-4f98-ae3d-a539947cf65e',
      callId: targetCallId,
      revisionId: null,
      sourceJobId: null,
      speaker: transcript.speaker,
      text: transcript.text,
      isFinal: transcript.isFinal,
      startMs: transcript.startMs,
      endMs: transcript.isFinal ? transcript.endMs : null,
      createdAt: '2026-06-01T00:00:00.000Z',
    })),
    listTranscripts: vi.fn(async () => []),
    commitRevision: vi.fn(async () => revision),
    listRevisions: vi.fn(async () => [revision]),
    activateRevision: vi.fn(async () => ({ ...revision, active: true })),
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
      getMeetingMinute: vi.fn(),
      bindLegacyAnalysisToRevision: vi.fn(),
      setLatestMeetingMinute: vi.fn(),
      setMeetingAnalysis: vi.fn(),
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

function finalTranscript(text: string): Transcript {
  return {
    speaker: 'counterpart',
    text,
    isFinal: true,
    startMs: 0,
    endMs: 100,
  };
}
