import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
        tenantId: '00000000-0000-4000-8000-000000000001',
        organizationId: '00000000-0000-4000-8000-000000000002',
        source: 'manual_transcript',
        industry: 'insurance',
        productId: 'real_estate',
        recordingConsent: {
          status: 'granted',
          method: 'digital',
          capturedAt: '2026-05-18T00:00:00.000Z',
          noticeVersion: 'local-v1',
        },
        startedAt: new Date('2026-05-18T00:00:00.000Z'),
      });

      expect(call).toMatchObject({
        source: 'manual_transcript',
        industry: 'insurance',
        productId: 'real_estate',
        tenantId: '00000000-0000-4000-8000-000000000001',
        organizationId: '00000000-0000-4000-8000-000000000002',
        recordingConsent: {
          status: 'granted',
          method: 'digital',
        },
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

  it('creates a new store only when the file is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-local-calls-enoent-'));
    const filePath = join(directory, 'calls.json');

    try {
      const store = new LocalCallStore(filePath);
      await expect(store.listCalls()).resolves.toEqual([]);
      await expect(readFile(filePath, 'utf8')).resolves.toContain('"calls": []');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('does not overwrite corrupt JSON with an empty store', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-local-calls-corrupt-'));
    const filePath = join(directory, 'calls.json');
    await writeFile(filePath, '{not-json', 'utf8');

    try {
      const store = new LocalCallStore(filePath);
      await expect(store.listCalls()).rejects.toThrow();
      await expect(readFile(filePath, 'utf8')).resolves.toBe('{not-json');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
