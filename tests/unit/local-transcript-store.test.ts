import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalTranscriptStore } from '../../src/main/services/local-transcript-store';

describe('LocalTranscriptStore', () => {
  it('persists transcript segments by call id', async () => {
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
});
