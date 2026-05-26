import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalCallStore } from '../../src/main/services/local-call-store';

describe('LocalCallStore', () => {
  it('persists call lifecycle', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-local-calls-'));
    const filePath = join(directory, 'calls.json');

    try {
      const store = new LocalCallStore(filePath);
      const call = await store.createCall({
        source: 'manual_transcript',
        industry: 'insurance',
        productId: 'real_estate',
        startedAt: new Date('2026-05-18T00:00:00.000Z'),
      });

      expect(call).toMatchObject({
        source: 'manual_transcript',
        industry: 'insurance',
        productId: 'real_estate',
        status: 'active',
        endedAt: null,
      });

      const ended = await store.endCall(call.id, new Date('2026-05-18T00:10:00.000Z'));
      expect(ended).toMatchObject({
        id: call.id,
        status: 'ended',
        endedAt: '2026-05-18T00:10:00.000Z',
      });

      const restored = new LocalCallStore(filePath);
      await expect(restored.listCalls()).resolves.toMatchObject([
        {
          id: call.id,
          status: 'ended',
          source: 'manual_transcript',
        },
      ]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
