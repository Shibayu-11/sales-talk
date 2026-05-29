import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { z } from 'zod';
import { AudioAssetSchema } from '@shared/schemas';
import type { AudioAsset } from '@shared/types';

const LocalAudioAssetDataSchema = z.object({
  assets: z.array(AudioAssetSchema),
});

interface LocalAudioAssetData {
  assets: AudioAsset[];
}

const DEFAULT_AUDIO_ASSET_DATA: LocalAudioAssetData = {
  assets: [],
};

const ALLOWED_AUDIO_EXTENSIONS = new Set(['.m4a', '.mp3', '.wav', '.aac', '.mp4', '.webm']);

export class LocalAudioAssetStore {
  private cache: LocalAudioAssetData | null = null;

  constructor(
    private readonly filePath = join(defaultUserDataPath(), 'local-audio-assets.json'),
    private readonly assetDirectory = join(defaultUserDataPath(), 'audio-assets'),
  ) {}

  async importAudioFile(input: { callId: string; filePath: string }): Promise<AudioAsset> {
    const extension = extname(input.filePath).toLowerCase();
    if (!ALLOWED_AUDIO_EXTENSIONS.has(extension)) {
      throw new Error('Unsupported audio file type');
    }

    const fileStats = await stat(input.filePath);
    if (!fileStats.isFile()) {
      throw new Error('Audio import target is not a file');
    }

    const id = randomUUID();
    const callAssetDirectory = join(this.assetDirectory, input.callId);
    const storedPath = join(callAssetDirectory, `${id}${extension}`);
    await mkdir(callAssetDirectory, { recursive: true });
    await copyFile(input.filePath, storedPath);

    const asset: AudioAsset = {
      id,
      callId: input.callId,
      fileName: basename(input.filePath),
      originalPath: input.filePath,
      storedPath,
      mimeType: mimeTypeForExtension(extension),
      sizeBytes: fileStats.size,
      createdAt: new Date().toISOString(),
    };
    const data = await this.get();
    const next = { assets: [asset, ...data.assets] };
    this.cache = next;
    await this.persist(next);
    return asset;
  }

  async listAudioAssets(callId: string): Promise<AudioAsset[]> {
    const data = await this.get();
    return data.assets.filter((asset) => asset.callId === callId);
  }

  private async get(): Promise<LocalAudioAssetData> {
    if (this.cache) {
      return this.cache;
    }

    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.cache = LocalAudioAssetDataSchema.parse(JSON.parse(raw));
      return this.cache;
    } catch {
      this.cache = DEFAULT_AUDIO_ASSET_DATA;
      await this.persist(this.cache);
      return this.cache;
    }
  }

  private async persist(data: LocalAudioAssetData): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }
}

export const localAudioAssetStore = new LocalAudioAssetStore();

function mimeTypeForExtension(extension: string): string {
  switch (extension) {
    case '.m4a':
      return 'audio/mp4';
    case '.mp3':
      return 'audio/mpeg';
    case '.wav':
      return 'audio/wav';
    case '.aac':
      return 'audio/aac';
    case '.mp4':
      return 'video/mp4';
    case '.webm':
      return 'audio/webm';
    default:
      return 'application/octet-stream';
  }
}

function defaultUserDataPath(): string {
  return process.env.SALES_TALK_USER_DATA_PATH ?? app?.getPath?.('userData') ?? process.cwd();
}
