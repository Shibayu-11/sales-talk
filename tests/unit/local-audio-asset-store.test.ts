import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LocalAudioAssetStore } from '../../src/main/services/local-audio-asset-store';

vi.mock('electron', () => ({
  app: {
    getPath: () => process.env.SALES_TALK_USER_DATA_PATH ?? process.cwd(),
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`wrapped:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^wrapped:/, ''),
  },
}));

describe('LocalAudioAssetStore', () => {
  it('encrypts imported assets and materializes a short-lived readable lease', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-local-audio-assets-'));
    const filePath = join(directory, 'assets.json');
    const assetDirectory = join(directory, 'audio-assets');
    const sourcePath = join(directory, 'sample.m4a');
    await writeFile(sourcePath, 'audio-bytes');

    try {
      const store = new LocalAudioAssetStore(filePath, assetDirectory);
      const asset = await store.importAudioFile({
        callId: 'ce710872-1efd-4965-8ca4-e4d13f810250',
        filePath: sourcePath,
      });
      const duplicate = await store.importAudioFile({
        callId: 'ce710872-1efd-4965-8ca4-e4d13f810250',
        filePath: sourcePath,
      });

      expect(asset).toMatchObject({
        callId: 'ce710872-1efd-4965-8ca4-e4d13f810250',
        fileName: 'sample.m4a',
        mimeType: 'audio/mp4',
        sizeBytes: 11,
      });
      expect(asset.storedPath.endsWith('.enc')).toBe(true);
      expect(duplicate.id).toBe(asset.id);

      const encrypted = await readFile(asset.storedPath);
      expect(encrypted.includes(Buffer.from('audio-bytes'))).toBe(false);
      await expect(readFile(filePath, 'utf8')).resolves.toContain('wrappedMasterKey');

      const lease = await store.materializeReadableAsset(asset);
      expect(lease.filePath).not.toBe(asset.storedPath);
      await expect(readFile(lease.filePath, 'utf8')).resolves.toBe('audio-bytes');
      await lease.cleanup();
      await expect(access(lease.filePath)).rejects.toMatchObject({ code: 'ENOENT' });

      const restored = new LocalAudioAssetStore(filePath, assetDirectory);
      const restoredAssets = await restored.listAudioAssets(
        'ce710872-1efd-4965-8ca4-e4d13f810250',
      );
      expect(restoredAssets).toHaveLength(1);
      expect(restoredAssets).toMatchObject([{ id: asset.id, fileName: 'sample.m4a' }]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('preserves existing plaintext assets through the readable lease API', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-local-audio-assets-legacy-'));
    const filePath = join(directory, 'assets.json');
    const sourcePath = join(directory, 'legacy.wav');
    await writeFile(sourcePath, 'legacy-audio');
    await writeFile(
      filePath,
      `${JSON.stringify({
        assets: [
          {
            id: 'e3aa5d3e-6f23-4f3c-bfc6-b0453eaa4ff3',
            callId: 'ce710872-1efd-4965-8ca4-e4d13f810250',
            fileName: 'legacy.wav',
            originalPath: sourcePath,
            storedPath: sourcePath,
            mimeType: 'audio/wav',
            sizeBytes: 12,
            createdAt: '2026-06-01T00:00:00.000Z',
          },
        ],
      })}\n`,
    );

    try {
      const store = new LocalAudioAssetStore(filePath, join(directory, 'audio-assets'));
      const [asset] = await store.listAudioAssets('ce710872-1efd-4965-8ca4-e4d13f810250');
      expect(asset).toBeDefined();
      const lease = await store.materializeReadableAsset(asset!);
      expect(lease.filePath).toBe(sourcePath);
      await expect(readFile(lease.filePath, 'utf8')).resolves.toBe('legacy-audio');
      await lease.cleanup();
      await expect(readFile(sourcePath, 'utf8')).resolves.toBe('legacy-audio');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('does not wipe corrupt metadata during initialization', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-local-audio-assets-corrupt-'));
    const filePath = join(directory, 'assets.json');
    await writeFile(filePath, '{"assets":', 'utf8');

    try {
      const store = new LocalAudioAssetStore(filePath, join(directory, 'audio-assets'));
      await expect(
        store.listAudioAssets('ce710872-1efd-4965-8ca4-e4d13f810250'),
      ).rejects.toThrow();
      await expect(readFile(filePath, 'utf8')).resolves.toBe('{"assets":');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('counts checkpoint and recovery data against the shared storage quota', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-local-audio-assets-quota-'));
    const assetDirectory = join(directory, 'audio-assets');
    const checkpointDirectory = join(directory, 'audio-checkpoints');
    const sourcePath = join(directory, 'sample.wav');
    await mkdir(checkpointDirectory, { recursive: true });
    await writeFile(join(checkpointDirectory, 'existing.bin'), Buffer.alloc(8));
    await writeFile(sourcePath, Buffer.alloc(4));

    try {
      const store = new LocalAudioAssetStore(join(directory, 'assets.json'), assetDirectory, {
        maxStorageBytes: 10,
      });
      await expect(
        store.importAudioFile({
          callId: 'ce710872-1efd-4965-8ca4-e4d13f810250',
          filePath: sourcePath,
        }),
      ).rejects.toThrow('Audio asset storage quota exceeded');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('rejects unsupported file extensions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-local-audio-assets-'));
    const sourcePath = join(directory, 'sample.txt');
    await writeFile(sourcePath, 'not audio');

    try {
      const store = new LocalAudioAssetStore(join(directory, 'assets.json'));
      await expect(
        store.importAudioFile({
          callId: 'ce710872-1efd-4965-8ca4-e4d13f810250',
          filePath: sourcePath,
        }),
      ).rejects.toThrow('Unsupported audio file type');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
