import { app, safeStorage } from 'electron';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { Transform, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { AudioAssetSchema } from '@shared/schemas';
import type { AudioAsset } from '@shared/types';
import { renameFileAtomic, writeFileAtomic } from './atomic-file';

const LOCAL_AUDIO_ASSET_DATA_VERSION = 2;
const DEFAULT_MAX_AUDIO_ASSET_STORAGE_BYTES = 5 * 1_024 * 1_024 * 1_024;
const TEMP_FILE_MAX_AGE_MS = 6 * 60 * 60 * 1_000;

const LocalAudioAssetEncryptionMetadataSchema = z
  .object({
    version: z.literal(1),
    algorithm: z.literal('aes-256-gcm'),
    iv: z.string().min(1),
    authTag: z.string().min(1),
    plaintextSha256: z.string().regex(/^[a-f0-9]{64}$/),
    ciphertextSha256: z.string().regex(/^[a-f0-9]{64}$/),
    plaintextSizeBytes: z.number().int().nonnegative(),
    ciphertextSizeBytes: z.number().int().nonnegative(),
    createdAt: z.string(),
  })
  .strict();

const LocalAudioAssetDataSchema = z.object({
  version: z.number().int().positive().default(LOCAL_AUDIO_ASSET_DATA_VERSION),
  wrappedMasterKey: z.string().min(1).nullable().default(null),
  assets: z.array(AudioAssetSchema),
  encryptionByAssetId: z.record(LocalAudioAssetEncryptionMetadataSchema).default({}),
});

type LocalAudioAssetEncryptionMetadata = z.infer<
  typeof LocalAudioAssetEncryptionMetadataSchema
>;

interface LocalAudioAssetData {
  version: number;
  wrappedMasterKey: string | null;
  assets: AudioAsset[];
  encryptionByAssetId: Record<string, LocalAudioAssetEncryptionMetadata>;
}

export interface LocalAudioAssetStoreOptions {
  maxStorageBytes?: number | undefined;
  tempDirectory?: string | undefined;
  relatedStorageDirectories?: string[] | undefined;
  now?: (() => Date) | undefined;
}

export interface AudioAssetReadableLease {
  asset: AudioAsset;
  filePath: string;
  cleanup(): Promise<void>;
}

const ALLOWED_AUDIO_EXTENSIONS = new Set(['.m4a', '.mp3', '.wav', '.aac', '.mp4', '.webm']);

export class LocalAudioAssetStore {
  private cache: LocalAudioAssetData | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly maxStorageBytes: number;
  private readonly tempDirectory: string;
  private readonly relatedStorageDirectories: string[];
  private readonly now: () => Date;

  constructor(
    private readonly filePath = join(defaultUserDataPath(), 'local-audio-assets.json'),
    private readonly assetDirectory = join(defaultUserDataPath(), 'audio-assets'),
    options: LocalAudioAssetStoreOptions = {},
  ) {
    this.maxStorageBytes = options.maxStorageBytes ?? DEFAULT_MAX_AUDIO_ASSET_STORAGE_BYTES;
    this.tempDirectory = options.tempDirectory ?? join(assetDirectory, '.tmp');
    this.relatedStorageDirectories = options.relatedStorageDirectories ?? [
      join(dirname(assetDirectory), 'audio-checkpoints'),
      join(dirname(assetDirectory), 'recovered-audio'),
    ];
    this.now = options.now ?? (() => new Date());
  }

  async importAudioFile(input: { callId: string; filePath: string }): Promise<AudioAsset> {
    const extension = extname(input.filePath).toLowerCase();
    if (!ALLOWED_AUDIO_EXTENSIONS.has(extension)) {
      throw new Error('Unsupported audio file type');
    }

    const fileStats = await stat(input.filePath);
    if (!fileStats.isFile()) {
      throw new Error('Audio import target is not a file');
    }

    const fileName = basename(input.filePath);
    return this.mutate(async (data) => {
      const existing = data.assets.find(
        (asset) => asset.callId === input.callId && asset.fileName === fileName,
      );
      if (existing) {
        return { next: data, result: existing };
      }

      await this.prepareAssetDirectories();
      await this.cleanupStaleTempFiles();
      await this.assertStorageBudget(fileStats.size);

      const id = randomUUID();
      const createdAt = this.now().toISOString();
      const callAssetDirectory = join(this.assetDirectory, input.callId);
      const storedPath = join(callAssetDirectory, `${id}${extension}.enc`);
      await mkdir(callAssetDirectory, { recursive: true });
      await assertDirectoryNotSymlink(callAssetDirectory);

      const asset: AudioAsset = {
        id,
        callId: input.callId,
        fileName,
        originalPath: input.filePath,
        storedPath,
        mimeType: mimeTypeForExtension(extension),
        sizeBytes: fileStats.size,
        createdAt,
      };
      const masterKey = getOrCreateMasterKey(data);
      let encrypted = false;
      try {
        const encryption = await encryptFileToAsset({
          sourcePath: input.filePath,
          targetPath: storedPath,
          masterKey: masterKey.key,
          asset,
          createdAt,
        });
        encrypted = true;
        const next: LocalAudioAssetData = {
          version: LOCAL_AUDIO_ASSET_DATA_VERSION,
          wrappedMasterKey: masterKey.wrappedMasterKey,
          assets: [asset, ...data.assets],
          encryptionByAssetId: {
            ...data.encryptionByAssetId,
            [asset.id]: encryption,
          },
        };
        return { next, result: asset };
      } catch (error) {
        if (encrypted) {
          await rm(storedPath, { force: true }).catch(() => undefined);
        }
        throw error;
      }
    });
  }

  async listAudioAssets(callId: string): Promise<AudioAsset[]> {
    const data = await this.get();
    return data.assets.filter((asset) => asset.callId === callId);
  }

  async materializeReadableAsset(asset: AudioAsset): Promise<AudioAssetReadableLease> {
    const data = await this.get();
    const stored = data.assets.find((candidate) => candidate.id === asset.id) ?? asset;
    const encryption = data.encryptionByAssetId[stored.id];
    if (!encryption) {
      await assertFileNotSymlink(stored.storedPath);
      return {
        asset: stored,
        filePath: stored.storedPath,
        cleanup: async () => undefined,
      };
    }

    if (!data.wrappedMasterKey) {
      throw new Error('Encrypted audio asset master key is missing');
    }

    await this.prepareTempDirectory();
    await this.cleanupStaleTempFiles();
    const extension = extname(stored.fileName).toLowerCase() || '.audio';
    const materializedPath = join(
      this.tempDirectory,
      `readable-${stored.id}-${randomUUID()}${extension}`,
    );
    try {
      await decryptAssetToFile({
        sourcePath: stored.storedPath,
        targetPath: materializedPath,
        masterKey: unwrapMasterKey(data.wrappedMasterKey),
        asset: stored,
        encryption,
      });
      return {
        asset: stored,
        filePath: materializedPath,
        cleanup: async () => {
          await rm(materializedPath, { force: true }).catch(() => undefined);
        },
      };
    } catch (error) {
      await rm(materializedPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async get(): Promise<LocalAudioAssetData> {
    if (this.cache) {
      return this.cache;
    }

    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.cache = LocalAudioAssetDataSchema.parse(JSON.parse(raw));
      return this.cache;
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        throw error;
      }
      const initialized = createDefaultAudioAssetData();
      await this.persist(initialized);
      this.cache = initialized;
      return this.cache;
    }
  }

  private mutate<T>(
    operation: (data: LocalAudioAssetData) => Promise<{ next: LocalAudioAssetData; result: T }>,
  ): Promise<T> {
    const run = this.mutationQueue.then(async () => {
      const data = await this.get();
      const { next, result } = await operation(data);
      if (next !== data) {
        await this.persist(next);
        this.cache = next;
      }
      return result;
    });
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async persist(data: LocalAudioAssetData): Promise<void> {
    await writeFileAtomic(this.filePath, `${JSON.stringify(data, null, 2)}\n`);
  }

  private async prepareAssetDirectories(): Promise<void> {
    await mkdir(this.assetDirectory, { recursive: true });
    await assertDirectoryNotSymlink(this.assetDirectory);
    await assertPathWithinDirectory(dirname(this.assetDirectory), this.assetDirectory);
  }

  private async prepareTempDirectory(): Promise<void> {
    await this.prepareAssetDirectories();
    await mkdir(this.tempDirectory, { recursive: true });
    await assertDirectoryNotSymlink(this.tempDirectory);
    await assertPathWithinDirectory(this.assetDirectory, this.tempDirectory);
  }

  private async cleanupStaleTempFiles(): Promise<void> {
    await this.prepareTempDirectory();
    const entries = await readdir(this.tempDirectory, { withFileTypes: true });
    const cutoff = this.now().getTime() - TEMP_FILE_MAX_AGE_MS;
    await Promise.all(
      entries.map(async (entry) => {
        const filePath = join(this.tempDirectory, entry.name);
        const fileStats = await lstat(filePath).catch(() => null);
        if (!fileStats || fileStats.isSymbolicLink() || !fileStats.isFile()) {
          return;
        }
        if (fileStats.mtimeMs <= cutoff) {
          await rm(filePath, { force: true }).catch(() => undefined);
        }
      }),
    );
  }

  private async assertStorageBudget(additionalBytes: number): Promise<void> {
    let storedBytes = await sumDirectoryFileBytes(this.assetDirectory, {
      excludedDirectory: this.tempDirectory,
    });
    for (const directory of this.relatedStorageDirectories) {
      storedBytes += await sumDirectoryFileBytes(directory);
    }
    if (storedBytes + additionalBytes > this.maxStorageBytes) {
      throw new Error('Audio asset storage quota exceeded');
    }
  }
}

export const localAudioAssetStore = new LocalAudioAssetStore();

async function encryptFileToAsset(input: {
  sourcePath: string;
  targetPath: string;
  masterKey: Buffer;
  asset: AudioAsset;
  createdAt: string;
}): Promise<LocalAudioAssetEncryptionMetadata> {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', input.masterKey, iv);
  cipher.setAAD(assetAad(input.asset));
  const plaintext = createHashCounter();
  const ciphertext = createHashCounter();
  await writeStreamAtomic(input.targetPath, async (writable) => {
    await pipeline(createReadStream(input.sourcePath), plaintext.stream, cipher, ciphertext.stream, writable);
  });

  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    plaintextSha256: plaintext.digest(),
    ciphertextSha256: ciphertext.digest(),
    plaintextSizeBytes: plaintext.bytes,
    ciphertextSizeBytes: ciphertext.bytes,
    createdAt: input.createdAt,
  };
}

async function decryptAssetToFile(input: {
  sourcePath: string;
  targetPath: string;
  masterKey: Buffer;
  asset: AudioAsset;
  encryption: LocalAudioAssetEncryptionMetadata;
}): Promise<void> {
  await assertFileNotSymlink(input.sourcePath);
  const iv = Buffer.from(input.encryption.iv, 'base64');
  const authTag = Buffer.from(input.encryption.authTag, 'base64');
  if (iv.byteLength !== 12 || authTag.byteLength !== 16) {
    throw new Error('Encrypted audio asset metadata is invalid');
  }

  const decipher = createDecipheriv('aes-256-gcm', input.masterKey, iv);
  decipher.setAAD(assetAad(input.asset));
  decipher.setAuthTag(authTag);
  const ciphertext = createHashCounter();
  const plaintext = createHashCounter();
  await writeStreamAtomic(input.targetPath, async (writable) => {
    await pipeline(createReadStream(input.sourcePath), ciphertext.stream, decipher, plaintext.stream, writable);
  });

  if (
    plaintext.bytes !== input.encryption.plaintextSizeBytes ||
    ciphertext.bytes !== input.encryption.ciphertextSizeBytes ||
    plaintext.digest() !== input.encryption.plaintextSha256 ||
    ciphertext.digest() !== input.encryption.ciphertextSha256
  ) {
    throw new Error('Encrypted audio asset failed integrity validation');
  }
}

async function writeStreamAtomic(
  filePath: string,
  write: (writable: Writable) => Promise<void>,
): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(directory, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let renamed = false;

  try {
    const writable = createWriteStream(temporaryPath, { flags: 'wx' });
    await write(writable);
    const handle = await open(temporaryPath, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameFileAtomic(temporaryPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

function createHashCounter(): {
  stream: Transform;
  digest(): string;
  readonly bytes: number;
} {
  const hash = createHash('sha256');
  let bytes = 0;
  let digested: string | null = null;
  return {
    stream: new Transform({
      transform(chunk: Buffer, _encoding, callback): void {
        bytes += chunk.byteLength;
        hash.update(chunk);
        callback(null, chunk);
      },
    }),
    digest(): string {
      digested ??= hash.digest('hex');
      return digested;
    },
    get bytes(): number {
      return bytes;
    },
  };
}

function getOrCreateMasterKey(data: LocalAudioAssetData): {
  key: Buffer;
  wrappedMasterKey: string;
} {
  if (data.wrappedMasterKey) {
    return {
      key: unwrapMasterKey(data.wrappedMasterKey),
      wrappedMasterKey: data.wrappedMasterKey,
    };
  }
  const key = randomBytes(32);
  return {
    key,
    wrappedMasterKey: wrapMasterKey(key),
  };
}

function wrapMasterKey(masterKey: Buffer): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage encryption is not available');
  }
  return safeStorage.encryptString(masterKey.toString('base64')).toString('base64');
}

function unwrapMasterKey(wrappedMasterKey: string): Buffer {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage encryption is not available');
  }
  const unwrapped = safeStorage.decryptString(Buffer.from(wrappedMasterKey, 'base64'));
  const masterKey = Buffer.from(unwrapped, 'base64');
  if (masterKey.byteLength !== 32) {
    throw new Error('Encrypted audio asset master key is invalid');
  }
  return masterKey;
}

function assetAad(asset: Pick<AudioAsset, 'id' | 'callId' | 'fileName' | 'mimeType'>): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      id: asset.id,
      callId: asset.callId,
      fileName: asset.fileName,
      mimeType: asset.mimeType,
    }),
  );
}

async function assertFileNotSymlink(filePath: string): Promise<void> {
  const fileStats = await lstat(filePath);
  if (!fileStats.isFile() || fileStats.isSymbolicLink()) {
    throw new Error('Audio asset file path is not a regular file');
  }
}

async function assertDirectoryNotSymlink(directory: string): Promise<void> {
  const directoryStats = await lstat(directory);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new Error('Audio asset storage path is not a regular directory');
  }
}

async function assertPathWithinDirectory(parentDirectory: string, childPath: string): Promise<void> {
  const parent = await realpath(parentDirectory).catch(() => resolve(parentDirectory));
  const child = await realpath(childPath).catch(() => resolve(childPath));
  if (child !== parent && !child.startsWith(`${parent}${sep}`)) {
    throw new Error('Audio asset path escaped its storage directory');
  }
}

async function sumDirectoryFileBytes(
  directory: string,
  options: { excludedDirectory?: string | undefined } = {},
): Promise<number> {
  let resolvedExcluded: string | null = null;
  if (options.excludedDirectory) {
    resolvedExcluded = await realpath(options.excludedDirectory).catch(() =>
      resolve(options.excludedDirectory ?? ''),
    );
  }

  async function sum(currentDirectory: string): Promise<number> {
    const entries = await readdir(currentDirectory, { withFileTypes: true }).catch((error) => {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return [];
      }
      throw error;
    });
    let total = 0;
    for (const entry of entries) {
      const entryPath = join(currentDirectory, entry.name);
      const entryStats = await lstat(entryPath).catch(() => null);
      if (!entryStats || entryStats.isSymbolicLink()) {
        continue;
      }
      if (entryStats.isDirectory()) {
        const resolvedEntry = await realpath(entryPath).catch(() => resolve(entryPath));
        if (resolvedExcluded && resolvedEntry === resolvedExcluded) {
          continue;
        }
        total += await sum(entryPath);
        continue;
      }
      if (entryStats.isFile()) {
        total += entryStats.size;
      }
    }
    return total;
  }

  return sum(directory);
}

function createDefaultAudioAssetData(): LocalAudioAssetData {
  return {
    version: LOCAL_AUDIO_ASSET_DATA_VERSION,
    wrappedMasterKey: null,
    assets: [],
    encryptionByAssetId: {},
  };
}

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
  return process.env.SALES_TALK_USER_DATA_PATH ?? app?.getPath?.('userData') ?? tmpdir();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
