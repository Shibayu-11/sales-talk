import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalSttJobStore } from '../../src/main/services/local-stt-job-store';

describe('LocalSttJobStore', () => {
  it('persists queued STT jobs by call id and updates status', async () => {
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
      });

      await expect(store.updateJobStatus(job.id, 'running')).resolves.toMatchObject({
        id: job.id,
        status: 'running',
      });

      const restored = new LocalSttJobStore(filePath);
      await expect(
        restored.listJobs('ce710872-1efd-4965-8ca4-e4d13f810250'),
      ).resolves.toMatchObject([{ id: job.id, status: 'running' }]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
