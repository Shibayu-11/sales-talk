import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalSttJobStore } from '../../src/main/services/local-stt-job-store';

describe('LocalSttJobStore', () => {
  it('persists queued STT jobs by call id and completes through CAS transitions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-local-stt-jobs-'));
    const filePath = join(directory, 'stt-jobs.json');

    try {
      const store = new LocalSttJobStore(filePath);
      const job = await store.createJob({
        callId: 'ce710872-1efd-4965-8ca4-e4d13f810250',
        audioAssetId: 'e3aa5d3e-6f23-4f3c-bfc6-b0453eaa4ff3',
      });

      expect(job).toMatchObject({
        callId: 'ce710872-1efd-4965-8ca4-e4d13f810250',
        audioAssetId: 'e3aa5d3e-6f23-4f3c-bfc6-b0453eaa4ff3',
        provider: 'deepgram',
        status: 'queued',
        runToken: null,
        progressPercent: 0,
        attempt: 1,
        retryReason: null,
        transcriptRevisionId: null,
        startedAt: null,
        completedAt: null,
      });

      const runToken = '00000000-0000-4000-8000-000000000111';
      await expect(store.claimQueued(job.id, runToken)).resolves.toMatchObject({
        id: job.id,
        status: 'running',
        runToken,
      });
      await expect(store.updateProgress(job.id, runToken, 25)).resolves.toMatchObject({
        id: job.id,
        status: 'running',
        progressPercent: 25,
      });
      await expect(
        store.completeJob({
          id: job.id,
          runToken,
          transcriptRevisionId: '19050688-f1c7-4f98-ae3d-a539947cf65e',
        }),
      ).resolves.toMatchObject({
        id: job.id,
        status: 'completed',
        runToken: null,
        progressPercent: 100,
        transcriptRevisionId: '19050688-f1c7-4f98-ae3d-a539947cf65e',
      });

      const restored = new LocalSttJobStore(filePath);
      await expect(
        restored.listJobs('ce710872-1efd-4965-8ca4-e4d13f810250'),
      ).resolves.toMatchObject([{ id: job.id, status: 'completed' }]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('reads old JSON with default retry lifecycle fields', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-local-stt-jobs-'));
    const filePath = join(directory, 'stt-jobs.json');

    try {
      await writeFile(
        filePath,
        `${JSON.stringify({
          jobs: [
            {
              id: '442db17c-6a3c-4e7e-856b-b11a4c1eab24',
              callId: 'ce710872-1efd-4965-8ca4-e4d13f810250',
              audioAssetId: 'e3aa5d3e-6f23-4f3c-bfc6-b0453eaa4ff3',
              provider: 'deepgram',
              status: 'queued',
              errorMessage: null,
              createdAt: '2026-06-01T00:00:00.000Z',
              updatedAt: '2026-06-01T00:00:00.000Z',
            },
          ],
        })}\n`,
      );

      const store = new LocalSttJobStore(filePath);
      await expect(
        store.getJob('442db17c-6a3c-4e7e-856b-b11a4c1eab24'),
      ).resolves.toMatchObject({
        progressPercent: 0,
        attempt: 1,
        retryReason: null,
        transcriptRevisionId: null,
        runToken: null,
        startedAt: null,
        completedAt: null,
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('reconciles persisted running jobs to failed on first load only', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-local-stt-jobs-'));
    const filePath = join(directory, 'stt-jobs.json');

    try {
      await writeFile(
        filePath,
        `${JSON.stringify({
          jobs: [
            {
              id: '442db17c-6a3c-4e7e-856b-b11a4c1eab24',
              callId: 'ce710872-1efd-4965-8ca4-e4d13f810250',
              audioAssetId: 'e3aa5d3e-6f23-4f3c-bfc6-b0453eaa4ff3',
              provider: 'deepgram',
              status: 'running',
              runToken: '00000000-0000-4000-8000-000000000111',
              progressPercent: 55,
              attempt: 1,
              retryReason: null,
              transcriptRevisionId: null,
              errorMessage: null,
              startedAt: '2026-06-01T00:00:05.000Z',
              completedAt: null,
              createdAt: '2026-06-01T00:00:00.000Z',
              updatedAt: '2026-06-01T00:00:05.000Z',
            },
            {
              id: '542db17c-6a3c-4e7e-856b-b11a4c1eab24',
              callId: 'ce710872-1efd-4965-8ca4-e4d13f810250',
              audioAssetId: 'f3aa5d3e-6f23-4f3c-bfc6-b0453eaa4ff3',
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
            },
            {
              id: '642db17c-6a3c-4e7e-856b-b11a4c1eab24',
              callId: 'ce710872-1efd-4965-8ca4-e4d13f810250',
              audioAssetId: 'a3aa5d3e-6f23-4f3c-bfc6-b0453eaa4ff3',
              provider: 'deepgram',
              status: 'completed',
              runToken: null,
              progressPercent: 100,
              attempt: 1,
              retryReason: null,
              transcriptRevisionId: null,
              errorMessage: null,
              startedAt: '2026-06-01T00:00:05.000Z',
              completedAt: '2026-06-01T00:00:20.000Z',
              createdAt: '2026-06-01T00:00:00.000Z',
              updatedAt: '2026-06-01T00:00:20.000Z',
            },
          ],
        })}\n`,
      );

      const store = new LocalSttJobStore(filePath);
      const jobs = await store.listJobs('ce710872-1efd-4965-8ca4-e4d13f810250');

      expect(jobs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: '442db17c-6a3c-4e7e-856b-b11a4c1eab24',
            status: 'failed',
            progressPercent: 55,
            errorMessage: 'STT processing was interrupted',
            completedAt: expect.any(String),
          }),
          expect.objectContaining({
            id: '542db17c-6a3c-4e7e-856b-b11a4c1eab24',
            status: 'queued',
            updatedAt: '2026-06-01T00:00:00.000Z',
          }),
          expect.objectContaining({
            id: '642db17c-6a3c-4e7e-856b-b11a4c1eab24',
            status: 'completed',
            updatedAt: '2026-06-01T00:00:20.000Z',
          }),
        ]),
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('creates retry jobs without overwriting the original job', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-local-stt-jobs-'));
    const filePath = join(directory, 'stt-jobs.json');

    try {
      const store = new LocalSttJobStore(filePath);
      const original = await store.createJob({
        callId: 'ce710872-1efd-4965-8ca4-e4d13f810250',
        audioAssetId: 'e3aa5d3e-6f23-4f3c-bfc6-b0453eaa4ff3',
        provider: 'apple_speech_analyzer',
      });
      const runToken = '00000000-0000-4000-8000-000000000111';
      await store.claimQueued(original.id, runToken);
      await store.updateProgress(original.id, runToken, 70);
      await store.failJob({
        id: original.id,
        runToken,
        errorMessage: 'noisy audio',
      });

      const retry = await store.retryJob({
        jobId: original.id,
        reason: 'cleaned_audio',
        provider: 'deepgram',
      });

      expect(retry).toMatchObject({
        callId: original.callId,
        audioAssetId: original.audioAssetId,
        provider: 'deepgram',
        status: 'queued',
        attempt: 2,
        retryReason: 'cleaned_audio',
      });
      await expect(store.getJob(original.id)).resolves.toMatchObject({
        id: original.id,
        status: 'failed',
        attempt: 1,
        retryReason: null,
        errorMessage: 'noisy audio',
      });
      await expect(store.listJobs(original.callId)).resolves.toHaveLength(2);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('only retries terminal jobs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-local-stt-jobs-'));
    const filePath = join(directory, 'stt-jobs.json');

    try {
      const store = new LocalSttJobStore(filePath);
      const queued = await store.createJob({
        callId: 'ce710872-1efd-4965-8ca4-e4d13f810250',
        audioAssetId: 'e3aa5d3e-6f23-4f3c-bfc6-b0453eaa4ff3',
      });

      await expect(
        store.retryJob({ jobId: queued.id, reason: 'operator_retry' }),
      ).rejects.toThrow('STT job retry requires a terminal job');

      const runToken = '00000000-0000-4000-8000-000000000111';
      await store.claimQueued(queued.id, runToken);
      await store.completeJob({
        id: queued.id,
        runToken,
        transcriptRevisionId: '19050688-f1c7-4f98-ae3d-a539947cf65e',
      });
      await expect(
        store.retryJob({ jobId: queued.id, reason: 'operator_retry' }),
      ).resolves.toMatchObject({
        status: 'queued',
        attempt: 2,
        retryReason: 'operator_retry',
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('rejects double claim and stale-token completion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-local-stt-jobs-'));
    const filePath = join(directory, 'stt-jobs.json');

    try {
      const store = new LocalSttJobStore(filePath);
      const job = await store.createJob({
        callId: 'ce710872-1efd-4965-8ca4-e4d13f810250',
        audioAssetId: 'e3aa5d3e-6f23-4f3c-bfc6-b0453eaa4ff3',
      });
      const runToken = '00000000-0000-4000-8000-000000000111';
      await store.claimQueued(job.id, runToken);

      await expect(
        store.claimQueued(job.id, '00000000-0000-4000-8000-000000000222'),
      ).rejects.toThrow('STT job runner only accepts queued jobs');
      await expect(
        store.completeJob({
          id: job.id,
          runToken: '00000000-0000-4000-8000-000000000222',
          transcriptRevisionId: '19050688-f1c7-4f98-ae3d-a539947cf65e',
        }),
      ).rejects.toThrow('STT job run token is no longer active');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('cancels a job as a terminal status', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-local-stt-jobs-'));
    const filePath = join(directory, 'stt-jobs.json');

    try {
      const store = new LocalSttJobStore(filePath);
      const job = await store.createJob({
        callId: 'ce710872-1efd-4965-8ca4-e4d13f810250',
        audioAssetId: 'e3aa5d3e-6f23-4f3c-bfc6-b0453eaa4ff3',
      });

      await expect(store.requestCancel(job.id)).resolves.toMatchObject({
        id: job.id,
        status: 'cancelled',
      });
      const cancelled = await store.getJob(job.id);
      expect(cancelled?.completedAt).toEqual(expect.any(String));
      await expect(store.requestCancel(job.id)).resolves.toMatchObject({
        id: job.id,
        status: 'cancelled',
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('rejects cancellation for completed or failed jobs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-local-stt-jobs-'));
    const filePath = join(directory, 'stt-jobs.json');

    try {
      const store = new LocalSttJobStore(filePath);
      const completed = await store.createJob({
        callId: 'ce710872-1efd-4965-8ca4-e4d13f810250',
        audioAssetId: 'e3aa5d3e-6f23-4f3c-bfc6-b0453eaa4ff3',
      });
      const runToken = '00000000-0000-4000-8000-000000000111';
      await store.claimQueued(completed.id, runToken);
      await store.completeJob({
        id: completed.id,
        runToken,
        transcriptRevisionId: '19050688-f1c7-4f98-ae3d-a539947cf65e',
      });

      await expect(store.requestCancel(completed.id)).rejects.toThrow(
        'STT job cancellation requires a queued or running job',
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('does not let cancellation win after activation-ready progress', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-local-stt-jobs-'));
    const filePath = join(directory, 'stt-jobs.json');

    try {
      const store = new LocalSttJobStore(filePath);
      const job = await store.createJob({
        callId: 'ce710872-1efd-4965-8ca4-e4d13f810250',
        audioAssetId: 'e3aa5d3e-6f23-4f3c-bfc6-b0453eaa4ff3',
      });
      const runToken = '00000000-0000-4000-8000-000000000111';
      await store.claimQueued(job.id, runToken);
      await store.updateProgress(job.id, runToken, 90);

      await expect(store.requestCancel(job.id)).rejects.toThrow(
        'STT job cancellation is no longer available',
      );
      await expect(
        store.completeJob({
          id: job.id,
          runToken,
          transcriptRevisionId: '19050688-f1c7-4f98-ae3d-a539947cf65e',
        }),
      ).resolves.toMatchObject({ status: 'completed' });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('serializes concurrent job creation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-local-stt-jobs-'));
    const filePath = join(directory, 'stt-jobs.json');
    const callId = 'ce710872-1efd-4965-8ca4-e4d13f810250';

    try {
      const store = new LocalSttJobStore(filePath);
      await Promise.all([
        store.createJob({
          callId,
          audioAssetId: 'e3aa5d3e-6f23-4f3c-bfc6-b0453eaa4ff3',
        }),
        store.createJob({
          callId,
          audioAssetId: 'f3aa5d3e-6f23-4f3c-bfc6-b0453eaa4ff3',
        }),
      ]);

      await expect(store.listJobs(callId)).resolves.toHaveLength(2);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
