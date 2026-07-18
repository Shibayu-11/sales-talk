import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalTranscriptStore } from '../../src/main/services/local-transcript-store';

describe('LocalTranscriptStore', () => {
  it('persists legacy transcript segments by call id', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-local-transcripts-'));
    const filePath = join(directory, 'transcripts.json');

    try {
      const store = new LocalTranscriptStore(filePath);
      await store.appendTranscript('ce710872-1efd-4965-8ca4-e4d13f810250', {
        speaker: 'counterpart',
        text: 'この商品は絶対儲かります。',
        isFinal: true,
        startMs: 1_000,
        endMs: 2_000,
      });
      await store.appendTranscript('b3f64fc4-04d0-43f1-bfc4-43418777f5be', {
        speaker: 'self',
        text: '別商談です。',
        isFinal: false,
        startMs: 3_000,
      });

      const restored = new LocalTranscriptStore(filePath);
      await expect(
        restored.listTranscripts('ce710872-1efd-4965-8ca4-e4d13f810250'),
      ).resolves.toMatchObject([
        {
          callId: 'ce710872-1efd-4965-8ca4-e4d13f810250',
          sourceJobId: null,
          speaker: 'counterpart',
          text: 'この商品は絶対儲かります。',
          isFinal: true,
          startMs: 1_000,
          endMs: 2_000,
        },
      ]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('migrates old JSON into a reversible original revision', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-local-transcripts-'));
    const filePath = join(directory, 'transcripts.json');

    try {
      await writeFile(
        filePath,
        `${JSON.stringify({
          segments: [
            {
              id: '19050688-f1c7-4f98-ae3d-a539947cf65e',
              callId: 'ce710872-1efd-4965-8ca4-e4d13f810250',
              speaker: 'counterpart',
              text: '旧形式です。',
              isFinal: true,
              startMs: 0,
              endMs: 500,
              createdAt: '2026-06-01T00:00:00.000Z',
            },
          ],
        })}\n`,
      );

      const store = new LocalTranscriptStore(filePath);
      await expect(
        store.listTranscripts('ce710872-1efd-4965-8ca4-e4d13f810250'),
      ).resolves.toMatchObject([
        {
          sourceJobId: null,
          text: '旧形式です。',
        },
      ]);
      await expect(
        store.listRevisions('ce710872-1efd-4965-8ca4-e4d13f810250'),
      ).resolves.toMatchObject([
        {
          origin: 'live',
          audioAssetId: null,
          sttJobId: null,
          provider: null,
          revisionNumber: 1,
          segmentCount: 1,
          active: true,
        },
      ]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('commits revisions without overwriting legacy output and activates by revision', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-local-transcripts-'));
    const filePath = join(directory, 'transcripts.json');
    const callId = 'ce710872-1efd-4965-8ca4-e4d13f810250';
    const sttJobId = '442db17c-6a3c-4e7e-856b-b11a4c1eab24';
    const audioAssetId = 'e3aa5d3e-6f23-4f3c-bfc6-b0453eaa4ff3';

    try {
      const store = new LocalTranscriptStore(filePath);
      await store.appendTranscript(callId, {
        speaker: 'counterpart',
        text: '初回の手入力です。',
        isFinal: true,
        startMs: 0,
        endMs: 500,
      });

      const revision = await store.commitRevision({
        callId,
        sttJobId,
        audioAssetId,
        provider: 'apple_speech_analyzer',
        reason: 'noise_reduction_retry',
        transcripts: [
          {
            speaker: 'counterpart',
            text: '再文字起こしです。',
            isFinal: true,
            startMs: 0,
            endMs: 700,
          },
        ],
      });

      expect(revision).toMatchObject({
        callId,
        audioAssetId,
        sttJobId,
        provider: 'apple_speech_analyzer',
        origin: 'audio_import',
        parentRevisionId: expect.any(String),
        revisionNumber: 2,
        reason: 'noise_reduction_retry',
        segmentCount: 1,
        active: false,
      });
      await expect(store.listTranscripts(callId)).resolves.toMatchObject([
        { text: '初回の手入力です。', sourceJobId: null },
      ]);

      await expect(store.activateRevision(callId, revision.id)).resolves.toMatchObject({
        id: revision.id,
        active: true,
      });
      await expect(store.listRevisions(callId)).resolves.toMatchObject([
        {
          revisionNumber: 1,
          origin: 'live',
          active: false,
        },
        {
          id: revision.id,
          revisionNumber: 2,
          segmentCount: 1,
          active: true,
        },
      ]);
      const originalRevision = (await store.listRevisions(callId))[0];
      expect(originalRevision).toBeDefined();
      await expect(store.activateRevision(callId, originalRevision?.id ?? '')).resolves.toMatchObject({
        origin: 'live',
        active: true,
      });
      await expect(store.listTranscripts(callId)).resolves.toMatchObject([
        { text: '初回の手入力です。', sourceJobId: null },
      ]);
      await store.activateRevision(callId, revision.id);
      await expect(store.listTranscripts(callId)).resolves.toMatchObject([
        {
          text: '再文字起こしです。',
          revisionId: revision.id,
          sourceJobId: sttJobId,
        },
      ]);

      const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
        activeRevisionByCallId?: Record<string, string>;
      };
      expect(persisted.activeRevisionByCallId?.[callId]).toBe(revision.id);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('serializes concurrent revision commits with increasing revision numbers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-local-transcripts-'));
    const filePath = join(directory, 'transcripts.json');
    const callId = 'ce710872-1efd-4965-8ca4-e4d13f810250';

    try {
      const store = new LocalTranscriptStore(filePath);
      const revisions = await Promise.all([
        store.commitRevision({
          callId,
          sttJobId: '442db17c-6a3c-4e7e-856b-b11a4c1eab24',
          audioAssetId: 'e3aa5d3e-6f23-4f3c-bfc6-b0453eaa4ff3',
          provider: 'deepgram',
          reason: 'first',
          transcripts: [],
        }),
        store.commitRevision({
          callId,
          sttJobId: '742db17c-6a3c-4e7e-856b-b11a4c1eab24',
          audioAssetId: 'f3aa5d3e-6f23-4f3c-bfc6-b0453eaa4ff3',
          provider: 'deepgram',
          reason: 'second',
          transcripts: [],
        }),
      ]);

      expect(revisions.map((revision) => revision.revisionNumber).sort()).toEqual([2, 3]);
      await expect(store.listRevisions(callId)).resolves.toHaveLength(3);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('rejects stale activation so a background job cannot override a user selection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-local-transcripts-'));
    const filePath = join(directory, 'transcripts.json');
    const callId = 'ce710872-1efd-4965-8ca4-e4d13f810250';

    try {
      const store = new LocalTranscriptStore(filePath);
      await store.appendTranscript(callId, {
        speaker: 'counterpart',
        text: '原本',
        isFinal: true,
        startMs: 0,
        endMs: 100,
      });
      const original = (await store.listRevisions(callId))[0];
      expect(original).toBeDefined();
      const first = await store.commitRevision({
        callId,
        sttJobId: '442db17c-6a3c-4e7e-856b-b11a4c1eab24',
        audioAssetId: 'e3aa5d3e-6f23-4f3c-bfc6-b0453eaa4ff3',
        provider: 'deepgram',
        reason: 'first',
        transcripts: [],
      });
      await store.activateRevision(callId, first.id, original?.id ?? null);
      const background = await store.commitRevision({
        callId,
        sttJobId: '742db17c-6a3c-4e7e-856b-b11a4c1eab24',
        audioAssetId: 'f3aa5d3e-6f23-4f3c-bfc6-b0453eaa4ff3',
        provider: 'deepgram',
        reason: 'background',
        transcripts: [],
      });
      await store.activateRevision(callId, original?.id ?? '', first.id);

      await expect(
        store.activateRevision(callId, background.id, background.parentRevisionId),
      ).rejects.toThrow('Active transcript revision changed during processing');
      await expect(store.listRevisions(callId)).resolves.toMatchObject([
        { id: original?.id, active: true },
        { id: first.id, active: false },
        { id: background.id, active: false },
      ]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
