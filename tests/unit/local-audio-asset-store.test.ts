import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalAudioAssetStore } from '../../src/main/services/local-audio-asset-store';

describe('LocalAudioAssetStore', () => {
  it('copies and persists imported audio assets by call id', async () => {
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

      expect(asset).toMatchObject({
        callId: 'ce710872-1efd-4965-8ca4-e4d13f810250',
        fileName: 'sample.m4a',
        mimeType: 'audio/mp4',
        sizeBytes: 11,
      });
      await expect(readFile(asset.storedPath, 'utf8')).resolves.toBe('audio-bytes');

      const restored = new LocalAudioAssetStore(filePath, assetDirectory);
      await expect(
        restored.listAudioAssets('ce710872-1efd-4965-8ca4-e4d13f810250'),
      ).resolves.toMatchObject([{ id: asset.id, fileName: 'sample.m4a' }]);
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
