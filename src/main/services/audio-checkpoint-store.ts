import { app, safeStorage } from 'electron';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { lstat, mkdir, open, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  AuditLogEntrySchema,
  MeetingSourceSchema,
  ProductIdSchema,
  SpeakerSchema,
} from '@shared/schemas';
import type {
  AudioChunk,
  AuditLogEntry,
  CallSession,
  RecoveryRetentionDays,
  RecoveryState,
  RecoverySummary,
  Speaker,
} from '@shared/types';
import { renameFileAtomic, writeFileAtomic } from './atomic-file';

const CHECKPOINT_VERSION = 1;
const DEFAULT_RETENTION_DAYS: RecoveryRetentionDays = 7;
const FLUSH_DURATION_MS = 5_000;
const FLUSH_BYTES = 1_048_576;
const MAX_CHUNK_BYTES = FLUSH_BYTES;
const MAX_SEGMENT_BYTES = FLUSH_BYTES * 2;
const MAX_SEGMENTS_PER_CALL = 10_000;
const MAX_SPEAKER_BYTES = 512 * 1_048_576;
const MAX_CALL_BYTES = 1_024 * 1_048_576;
const MAX_ROOT_BYTES = 5 * 1_024 * 1_048_576;
const MAX_PENDING_CHECKPOINT_BYTES = 2 * 1_048_576;
const MAX_PENDING_CHECKPOINT_CHUNKS = 32;
const AUDIO_SAMPLE_RATE = 16_000;
const AUDIO_CHANNELS = 1;
const AUDIO_BITS_PER_SAMPLE = 16;
const SEGMENT_FILE_NAME_PATTERN = /^segment-\d{6}\.bin$/;
const CallIdSchema = z.string().uuid();

const CheckpointSegmentManifestSchema = z
  .object({
    index: z.number().int().nonnegative().max(MAX_SEGMENTS_PER_CALL - 1),
    speaker: SpeakerSchema,
    fileName: z.string().regex(SEGMENT_FILE_NAME_PATTERN),
    iv: z.string().min(1),
    authTag: z.string().min(1),
    startMs: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    chunkCount: z.number().int().positive(),
    byteLength: z.number().int().positive().max(MAX_SEGMENT_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.string().datetime(),
  })
  .strict();

const UnsignedCheckpointManifestSchema = z
  .object({
    version: z.literal(CHECKPOINT_VERSION),
    callId: CallIdSchema,
    tenantId: z.string().uuid(),
    organizationId: z.string().uuid(),
    ownerUserId: z.string().uuid().nullable().optional(),
    ownerMembershipId: z.string().uuid().nullable().optional(),
    productId: ProductIdSchema,
    source: MeetingSourceSchema,
    state: z.enum(['recording', 'recoverable', 'recovering', 'partial']),
    startedAt: z.string().datetime(),
    lastCheckpointAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    retentionDays: z.union([z.literal(1), z.literal(7), z.literal(30)]),
    wrappedSessionKey: z.string().min(1),
    pendingAuditEntry: AuditLogEntrySchema.nullable().optional(),
    chunkCount: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    segments: z.array(CheckpointSegmentManifestSchema).max(MAX_SEGMENTS_PER_CALL),
  })
  .strict();

const CheckpointManifestSchema = UnsignedCheckpointManifestSchema.extend({
  manifestHmac: z.string().min(1),
}).strict();

type CheckpointSegmentManifest = z.infer<typeof CheckpointSegmentManifestSchema>;
type UnsignedCheckpointManifest = z.infer<typeof UnsignedCheckpointManifestSchema>;
type CheckpointManifest = z.infer<typeof CheckpointManifestSchema>;

interface PendingSpeakerBuffer {
  speaker: Speaker;
  chunks: Buffer[];
  startMs: number;
  durationMs: number;
  chunkCount: number;
  bytes: number;
}

interface PreparedCheckpointChunk {
  chunk: AudioChunk;
  pcm: Buffer;
}

interface AuthenticatedManifest {
  manifest: CheckpointManifest;
  sessionKey: Buffer;
}

interface StreamingWavTarget {
  speaker: Speaker;
  temporaryPath: string;
  filePath: string;
  handle: FileHandle;
  pcmBytes: number;
}

export interface BeginCheckpointInput {
  call: CallSession;
  retentionDays?: RecoveryRetentionDays | undefined;
  ownerUserId?: string | null | undefined;
  ownerMembershipId?: string | null | undefined;
  now?: Date | undefined;
}

export interface RecoveredWavFile {
  speaker: Speaker;
  filePath: string;
  sizeBytes: number;
}

export interface CheckpointRecoveryOutput {
  summary: RecoverySummary;
  wavFiles: RecoveredWavFile[];
}

export interface CheckpointRetentionSnapshot {
  retentionDays: RecoveryRetentionDays;
  expiresAt: string;
}

export class CheckpointIntegrityError extends Error {
  constructor(message = 'Encrypted checkpoint failed integrity validation') {
    super(message);
    this.name = 'CheckpointIntegrityError';
  }
}

export class CheckpointQuotaError extends Error {
  constructor(message = 'Audio checkpoint storage quota exceeded') {
    super(message);
    this.name = 'CheckpointQuotaError';
  }
}

export class RecordingCheckpointSink {
  private readonly pendingBySpeaker = new Map<Speaker, PendingSpeakerBuffer>();
  private queue: Promise<void> = Promise.resolve();
  private failure: Error | null = null;
  private closed = false;
  private originStartMs: number | null = null;
  private queuedBytes = 0;
  private queuedChunks = 0;

  constructor(
    private readonly store: EncryptedAudioCheckpointStore,
    private manifest: CheckpointManifest,
    private readonly sessionKey: Buffer,
  ) {}

  write(chunk: AudioChunk): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('Checkpoint sink is already closed'));
    }
    if (this.failure) {
      return Promise.reject(this.failure);
    }

    const prepared = prepareCheckpointChunk(chunk);
    if (
      this.queuedChunks + 1 > MAX_PENDING_CHECKPOINT_CHUNKS ||
      this.queuedBytes + prepared.pcm.byteLength > MAX_PENDING_CHECKPOINT_BYTES
    ) {
      const error = new CheckpointQuotaError('Audio checkpoint backpressure limit exceeded');
      this.failure = error;
      return Promise.reject(error);
    }
    this.queuedBytes += prepared.pcm.byteLength;
    this.queuedChunks += 1;

    const run = this.queue.then(async () => {
      if (this.failure) {
        throw this.failure;
      }
      await this.writeOrdered(prepared);
    }).finally(() => {
      this.queuedBytes -= prepared.pcm.byteLength;
      this.queuedChunks -= 1;
    });
    this.queue = run.catch((error: unknown) => {
      this.failure = normalizeError(error);
    });
    return run;
  }

  async drain(): Promise<void> {
    this.closed = true;
    await this.queue;
    if (this.failure) {
      throw this.failure;
    }
    await this.flushAll();
  }

  private async writeOrdered(prepared: PreparedCheckpointChunk): Promise<void> {
    const { chunk, pcm } = prepared;
    const roundedStartMs = Math.max(0, Math.round(chunk.startMs));
    this.originStartMs ??= roundedStartMs;
    const normalizedChunk: AudioChunk = {
      ...chunk,
      startMs: Math.max(0, roundedStartMs - this.originStartMs),
      durationMs: Math.max(0, Math.round(chunk.durationMs)),
    };
    const existing = this.pendingBySpeaker.get(chunk.speaker);
    if (existing && existing.bytes + pcm.byteLength > MAX_SEGMENT_BYTES) {
      await this.flushSpeaker(chunk.speaker);
    }

    const pending = this.appendPending(normalizedChunk, pcm);
    if (pending.durationMs >= FLUSH_DURATION_MS || pending.bytes >= FLUSH_BYTES) {
      await this.flushSpeaker(chunk.speaker);
    }
  }

  private appendPending(chunk: AudioChunk, pcm: Buffer): PendingSpeakerBuffer {
    const existing = this.pendingBySpeaker.get(chunk.speaker);
    if (existing) {
      existing.chunks.push(pcm);
      existing.durationMs += chunk.durationMs;
      existing.chunkCount += 1;
      existing.bytes += pcm.byteLength;
      return existing;
    }

    const pending: PendingSpeakerBuffer = {
      speaker: chunk.speaker,
      chunks: [pcm],
      startMs: chunk.startMs,
      durationMs: chunk.durationMs,
      chunkCount: 1,
      bytes: pcm.byteLength,
    };
    this.pendingBySpeaker.set(chunk.speaker, pending);
    return pending;
  }

  private async flushAll(): Promise<void> {
    for (const speaker of Array.from(this.pendingBySpeaker.keys())) {
      await this.flushSpeaker(speaker);
    }
  }

  private async flushSpeaker(speaker: Speaker): Promise<void> {
    const pending = this.pendingBySpeaker.get(speaker);
    if (!pending || pending.bytes === 0) {
      return;
    }

    this.manifest = await this.store.flushSegment(this.manifest, this.sessionKey, pending);
    this.pendingBySpeaker.delete(speaker);
  }
}

export class EncryptedAudioCheckpointStore {
  constructor(
    private readonly rootDirectory = join(defaultUserDataPath(), 'audio-checkpoints'),
    private readonly recoveredDirectory = join(defaultUserDataPath(), 'recovered-audio'),
    private readonly assetDirectory = join(defaultUserDataPath(), 'audio-assets'),
  ) {}

  async beginRecording(input: BeginCheckpointInput): Promise<RecordingCheckpointSink> {
    const now = input.now ?? new Date();
    const retentionDays = input.retentionDays ?? DEFAULT_RETENTION_DAYS;
    const callId = CallIdSchema.parse(input.call.id);
    if ((await this.getStoredBytes()) >= MAX_ROOT_BYTES) {
      throw new CheckpointQuotaError();
    }

    const sessionKey = randomBytes(32);
    const wrappedSessionKey = wrapSessionKey(sessionKey);
    const sessionDirectory = this.sessionDirectory(callId);
    await this.ensureCheckpointRootDirectory();
    try {
      await mkdir(sessionDirectory);
      await this.assertCheckpointSessionDirectory(callId);
    } catch (error) {
      if (isNodeError(error) && error.code === 'EEXIST') {
        throw new Error('Audio checkpoint already exists for this call');
      }
      throw error;
    }

    try {
      await mkdir(this.segmentsDirectory(callId));
      await this.assertCheckpointSegmentsDirectory(callId);
      const unsignedManifest: UnsignedCheckpointManifest = {
        version: CHECKPOINT_VERSION,
        callId,
        tenantId: input.call.tenantId,
        organizationId: input.call.organizationId,
        ownerUserId: input.ownerUserId ?? null,
        ownerMembershipId: input.ownerMembershipId ?? null,
        productId: input.call.productId,
        source: input.call.source,
        state: 'recording',
        startedAt: input.call.startedAt,
        lastCheckpointAt: now.toISOString(),
        expiresAt: addDays(now, retentionDays).toISOString(),
        retentionDays,
        wrappedSessionKey,
        pendingAuditEntry: null,
        chunkCount: 0,
        durationMs: 0,
        segments: [],
      };
      const manifest = await this.writeManifest(unsignedManifest, sessionKey);
      return new RecordingCheckpointSink(this, manifest, sessionKey);
    } catch (error) {
      await safeRemoveDirectory(sessionDirectory, 'checkpoint session').catch(() => undefined);
      throw error;
    }
  }

  async listSummaries(activeCallId: string | null = null): Promise<RecoverySummary[]> {
    const callIds = await this.listCheckpointCallIds();
    const summaries = await Promise.all(
      callIds.map(async (callId) => {
        const { manifest } = await this.readAuthenticatedManifest(callId);
        return this.toSummary(manifest, activeCallId);
      }),
    );
    return summaries.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  async getSummary(
    callId: string,
    activeCallId: string | null = null,
  ): Promise<RecoverySummary | null> {
    const authenticated = await this.readAuthenticatedManifestOrNull(callId);
    return authenticated ? this.toSummary(authenticated.manifest, activeCallId) : null;
  }

  async recoverToWavFiles(callId: string): Promise<CheckpointRecoveryOutput> {
    const { manifest, sessionKey } = await this.updateState(callId, 'recovering');
    const wavDirectory = join(this.recoveredDirectory, manifest.callId);
    const targets = new Map<Speaker, StreamingWavTarget>();

    await this.ensureRecoveredRootDirectory();
    await safeRemoveDirectory(wavDirectory, 'recovered audio directory');
    await this.assertRecoveryCapacity(manifest);
    await mkdir(wavDirectory, { recursive: true });
    await assertDirectoryNotSymlink(wavDirectory, 'recovered audio directory');
    await assertPathWithinDirectory(this.recoveredDirectory, wavDirectory);

    try {
      for (const speaker of sortedSpeakers([
        ...new Set(manifest.segments.map((segment) => segment.speaker)),
      ])) {
        const filePath = join(wavDirectory, `${manifest.callId}-${speaker}.wav`);
        const temporaryPath = `${filePath}.tmp`;
        const handle = await open(temporaryPath, 'wx+');
        await writeBuffer(handle, buildMonoWavHeader(0), null);
        targets.set(speaker, { speaker, temporaryPath, filePath, handle, pcmBytes: 0 });
      }

      for (const segment of manifest.segments) {
        const target = targets.get(segment.speaker);
        if (!target) {
          throw new CheckpointIntegrityError();
        }
        const plaintext = await this.decryptSegment(manifest, sessionKey, segment);
        const nextSpeakerBytes = target.pcmBytes + plaintext.byteLength;
        if (nextSpeakerBytes > MAX_SPEAKER_BYTES) {
          throw new CheckpointQuotaError('Recovered speaker audio exceeded the safety limit');
        }
        await writeBuffer(target.handle, plaintext, null);
        target.pcmBytes = nextSpeakerBytes;
      }

      const wavFiles: RecoveredWavFile[] = [];
      for (const speaker of sortedSpeakers(Array.from(targets.keys()))) {
        const target = targets.get(speaker);
        if (!target || target.pcmBytes === 0) {
          continue;
        }
        await writeBuffer(target.handle, buildMonoWavHeader(target.pcmBytes), 0);
        await target.handle.sync();
        await target.handle.close();
        targets.delete(speaker);
        await renameFileAtomic(target.temporaryPath, target.filePath);
        wavFiles.push({
          speaker: target.speaker,
          filePath: target.filePath,
          sizeBytes: 44 + target.pcmBytes,
        });
      }

      if (wavFiles.length === 0) {
        throw new CheckpointIntegrityError('Encrypted checkpoint had no recoverable audio');
      }

      return {
        summary: this.toSummary(manifest, null),
        wavFiles,
      };
    } catch (error) {
      await closeTargets(targets);
      await safeRemoveDirectory(wavDirectory, 'recovered audio directory').catch(() => undefined);
      if (error instanceof CheckpointIntegrityError || error instanceof CheckpointQuotaError) {
        await this.updateState(callId, 'partial').catch(() => undefined);
      } else {
        await this.resetRecoveringState(callId).catch(() => undefined);
      }
      throw error;
    }
  }

  async resetRecoveringState(callId: string): Promise<void> {
    const authenticated = await this.readAuthenticatedManifestOrNull(callId);
    if (!authenticated || authenticated.manifest.state !== 'recovering') {
      return;
    }
    await this.writeManifest(
      { ...withoutManifestHmac(authenticated.manifest), state: 'recoverable' },
      authenticated.sessionKey,
    );
  }

  async discard(callId: string): Promise<void> {
    const validCallId = CallIdSchema.parse(callId);
    await assertDirectoryNotSymlinkIfExists(this.rootDirectory, 'checkpoint root');
    await safeRemoveDirectory(this.sessionDirectory(validCallId), 'checkpoint session');
  }

  async removeRecoveredWavDirectory(callId: string): Promise<void> {
    const validCallId = CallIdSchema.parse(callId);
    await assertDirectoryNotSymlinkIfExists(this.recoveredDirectory, 'recovered audio root');
    await safeRemoveDirectory(join(this.recoveredDirectory, validCallId), 'recovered audio directory');
  }

  async stageRetention(
    callId: string,
    retentionDays: RecoveryRetentionDays,
    auditEntry: AuditLogEntry,
  ): Promise<RecoverySummary> {
    const authenticated = await this.readAuthenticatedManifest(callId);
    const expiresAt = addDays(new Date(), retentionDays).toISOString();
    const pendingAuditEntry = AuditLogEntrySchema.parse({
      ...auditEntry,
      metadata: {
        ...auditEntry.metadata,
        expiresAt,
      },
    });
    const next = await this.writeManifest(
      {
        ...withoutManifestHmac(authenticated.manifest),
        retentionDays,
        expiresAt,
        pendingAuditEntry,
      },
      authenticated.sessionKey,
    );
    return this.toSummary(next, null);
  }

  async getPendingAuditEntry(callId: string): Promise<AuditLogEntry | null> {
    const authenticated = await this.readAuthenticatedManifest(callId);
    return authenticated.manifest.pendingAuditEntry ?? null;
  }

  async completePendingAudit(callId: string, auditEntryId: string): Promise<void> {
    const authenticated = await this.readAuthenticatedManifest(callId);
    const pending = authenticated.manifest.pendingAuditEntry ?? null;
    if (!pending) {
      return;
    }
    if (pending.id !== auditEntryId) {
      throw new CheckpointIntegrityError('Checkpoint pending audit id did not match');
    }
    await this.writeManifest(
      {
        ...withoutManifestHmac(authenticated.manifest),
        pendingAuditEntry: null,
      },
      authenticated.sessionKey,
    );
  }

  async setRetention(
    callId: string,
    retentionDays: RecoveryRetentionDays,
  ): Promise<RecoverySummary> {
    const authenticated = await this.readAuthenticatedManifest(callId);
    const next = await this.writeManifest(
      {
        ...withoutManifestHmac(authenticated.manifest),
        retentionDays,
        expiresAt: addDays(new Date(), retentionDays).toISOString(),
      },
      authenticated.sessionKey,
    );
    return this.toSummary(next, null);
  }

  async restoreRetention(
    callId: string,
    snapshot: CheckpointRetentionSnapshot,
  ): Promise<RecoverySummary> {
    const authenticated = await this.readAuthenticatedManifest(callId);
    const next = await this.writeManifest(
      {
        ...withoutManifestHmac(authenticated.manifest),
        retentionDays: snapshot.retentionDays,
        expiresAt: snapshot.expiresAt,
      },
      authenticated.sessionKey,
    );
    return this.toSummary(next, null);
  }

  async flushSegment(
    manifest: CheckpointManifest,
    sessionKey: Buffer,
    pending: PendingSpeakerBuffer,
  ): Promise<CheckpointManifest> {
    const plaintext = Buffer.concat(pending.chunks, pending.bytes);
    if (plaintext.byteLength > MAX_SEGMENT_BYTES) {
      throw new CheckpointQuotaError('Audio checkpoint segment exceeded the safety limit');
    }
    if (manifest.segments.length >= MAX_SEGMENTS_PER_CALL) {
      throw new CheckpointQuotaError('Audio checkpoint segment count exceeded the safety limit');
    }

    const callBytes = manifest.segments.reduce((sum, segment) => sum + segment.byteLength, 0);
    const speakerBytes = manifest.segments
      .filter((segment) => segment.speaker === pending.speaker)
      .reduce((sum, segment) => sum + segment.byteLength, 0);
    if (callBytes + plaintext.byteLength > MAX_CALL_BYTES) {
      throw new CheckpointQuotaError('Audio checkpoint call quota exceeded');
    }
    if (speakerBytes + plaintext.byteLength > MAX_SPEAKER_BYTES) {
      throw new CheckpointQuotaError('Audio checkpoint speaker quota exceeded');
    }

    const rootBytes = await this.getStoredBytes();
    if (rootBytes + plaintext.byteLength > MAX_ROOT_BYTES) {
      throw new CheckpointQuotaError();
    }

    const index = manifest.segments.length;
    const iv = randomBytes(12);
    const aad = segmentAad(manifest, {
      index,
      speaker: pending.speaker,
      startMs: pending.startMs,
      durationMs: pending.durationMs,
      chunkCount: pending.chunkCount,
      byteLength: plaintext.byteLength,
    });
    const cipher = createCipheriv('aes-256-gcm', sessionKey, iv);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const fileName = expectedSegmentFileName(index);
    const segmentPath = this.resolveSegmentPath(manifest.callId, fileName);

    await this.assertCheckpointSegmentsDirectory(manifest.callId);
    await writeFileAtomic(segmentPath, encrypted);

    try {
      const now = new Date().toISOString();
      const segment: CheckpointSegmentManifest = {
        index,
        speaker: pending.speaker,
        fileName,
        iv: iv.toString('base64'),
        authTag: authTag.toString('base64'),
        startMs: pending.startMs,
        durationMs: pending.durationMs,
        chunkCount: pending.chunkCount,
        byteLength: plaintext.byteLength,
        sha256: createHash('sha256').update(encrypted).digest('hex'),
        createdAt: now,
      };
      return await this.writeManifest(
        {
          ...withoutManifestHmac(manifest),
          lastCheckpointAt: now,
          chunkCount: manifest.chunkCount + pending.chunkCount,
          durationMs: Math.max(manifest.durationMs, pending.startMs + pending.durationMs),
          segments: [...manifest.segments, segment],
        },
        sessionKey,
      );
    } catch (error) {
      await rm(segmentPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async decryptSegment(
    manifest: CheckpointManifest,
    sessionKey: Buffer,
    segment: CheckpointSegmentManifest,
  ): Promise<Buffer> {
    await this.assertCheckpointSessionDirectory(manifest.callId);
    await this.assertCheckpointSegmentsDirectory(manifest.callId);
    const segmentPath = this.resolveSegmentPath(manifest.callId, segment.fileName);
    const fileStats = await lstat(segmentPath);
    if (
      !fileStats.isFile() ||
      fileStats.isSymbolicLink() ||
      fileStats.size !== segment.byteLength ||
      fileStats.size > MAX_SEGMENT_BYTES
    ) {
      throw new CheckpointIntegrityError();
    }

    const encrypted = await readFile(segmentPath);
    if (encrypted.byteLength !== segment.byteLength) {
      throw new CheckpointIntegrityError();
    }
    const digest = createHash('sha256').update(encrypted).digest('hex');
    if (digest !== segment.sha256) {
      throw new CheckpointIntegrityError();
    }

    const iv = Buffer.from(segment.iv, 'base64');
    const authTag = Buffer.from(segment.authTag, 'base64');
    if (iv.byteLength !== 12 || authTag.byteLength !== 16) {
      throw new CheckpointIntegrityError();
    }

    try {
      const decipher = createDecipheriv('aes-256-gcm', sessionKey, iv);
      decipher.setAAD(segmentAad(manifest, segment));
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      if (plaintext.byteLength !== segment.byteLength) {
        throw new CheckpointIntegrityError();
      }
      return plaintext;
    } catch (error) {
      if (error instanceof CheckpointIntegrityError) {
        throw error;
      }
      throw new CheckpointIntegrityError();
    }
  }

  private async updateState(
    callId: string,
    state: RecoveryState,
  ): Promise<AuthenticatedManifest> {
    const authenticated = await this.readAuthenticatedManifest(callId);
    const manifest = await this.writeManifest(
      { ...withoutManifestHmac(authenticated.manifest), state },
      authenticated.sessionKey,
    );
    return { manifest, sessionKey: authenticated.sessionKey };
  }

  private async listCheckpointCallIds(): Promise<string[]> {
    try {
      await this.assertExistingCheckpointRootDirectory();
      const entries = await readdir(this.rootDirectory, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && CallIdSchema.safeParse(entry.name).success)
        .map((entry) => entry.name);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  private async readAuthenticatedManifestOrNull(
    callId: string,
  ): Promise<AuthenticatedManifest | null> {
    try {
      return await this.readAuthenticatedManifest(callId);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  private async readAuthenticatedManifest(callId: string): Promise<AuthenticatedManifest> {
    const validCallId = CallIdSchema.parse(callId);
    await this.assertCheckpointSessionDirectory(validCallId);
    await assertFileNotSymlink(this.manifestPath(validCallId), 'checkpoint manifest');
    const raw = await readFile(this.manifestPath(validCallId), 'utf8');
    const manifest = CheckpointManifestSchema.parse(JSON.parse(raw) as unknown);
    if (manifest.callId !== validCallId) {
      throw new CheckpointIntegrityError('Checkpoint directory did not match the manifest call id');
    }

    const sessionKey = unwrapSessionKey(manifest.wrappedSessionKey);
    const expectedHmac = Buffer.from(
      createManifestHmac(withoutManifestHmac(manifest), sessionKey),
      'base64',
    );
    const actualHmac = Buffer.from(manifest.manifestHmac, 'base64');
    if (
      expectedHmac.byteLength !== actualHmac.byteLength ||
      !timingSafeEqual(expectedHmac, actualHmac)
    ) {
      throw new CheckpointIntegrityError('Checkpoint manifest authentication failed');
    }
    const normalizedManifest = normalizeManifestForRead(manifest);
    validateManifestInvariants(normalizedManifest);
    return { manifest: normalizedManifest, sessionKey };
  }

  private async writeManifest(
    unsignedManifest: UnsignedCheckpointManifest,
    sessionKey: Buffer,
  ): Promise<CheckpointManifest> {
    const parsed = normalizeManifestForWrite(
      UnsignedCheckpointManifestSchema.parse(unsignedManifest),
    );
    validateManifestInvariants(parsed);
    const manifest: CheckpointManifest = {
      ...parsed,
      manifestHmac: createManifestHmac(parsed, sessionKey),
    };
    await this.assertCheckpointSessionDirectory(manifest.callId);
    await writeFileAtomic(
      this.manifestPath(manifest.callId),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    return manifest;
  }

  private toSummary(manifest: CheckpointManifest, activeCallId: string | null): RecoverySummary {
    const state =
      manifest.state === 'recording' && manifest.callId !== activeCallId
        ? 'recoverable'
        : manifest.state;

    return {
      callId: manifest.callId,
      tenantId: manifest.tenantId,
      organizationId: manifest.organizationId,
      ownerUserId: manifest.ownerUserId ?? null,
      ownerMembershipId: manifest.ownerMembershipId ?? null,
      productId: manifest.productId,
      source: manifest.source,
      state,
      startedAt: manifest.startedAt,
      lastCheckpointAt: manifest.lastCheckpointAt,
      expiresAt: manifest.expiresAt,
      retentionDays: manifest.retentionDays,
      expired: Date.parse(manifest.expiresAt) <= Date.now(),
      chunkCount: manifest.chunkCount,
      durationMs: manifest.durationMs,
      availableSpeakers: sortedSpeakers([
        ...new Set(manifest.segments.map((segment) => segment.speaker)),
      ]),
    };
  }

  private async getStoredBytes(): Promise<number> {
    return (
      (await this.getCheckpointSegmentBytes()) +
      (await sumDirectoryFileBytes(this.recoveredDirectory)) +
      (await sumDirectoryFileBytes(this.assetDirectory))
    );
  }

  private async getCheckpointSegmentBytes(): Promise<number> {
    let total = 0;
    for (const callId of await this.listCheckpointCallIds()) {
      try {
        await this.assertCheckpointSegmentsDirectory(callId);
        const entries = await readdir(this.segmentsDirectory(callId), { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() || !SEGMENT_FILE_NAME_PATTERN.test(entry.name)) {
            continue;
          }
          const fileStats = await lstat(this.resolveSegmentPath(callId, entry.name));
          if (fileStats.isFile() && !fileStats.isSymbolicLink()) {
            total += fileStats.size;
          }
        }
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT') {
          throw error;
        }
      }
    }
    return total;
  }

  private async assertRecoveryCapacity(manifest: CheckpointManifest): Promise<void> {
    const requiredBytes = estimateRecoveredWavBytes(manifest) * 2;
    if ((await this.getStoredBytes()) + requiredBytes > MAX_ROOT_BYTES) {
      throw new CheckpointQuotaError('Recovered WAV output would exceed the storage quota');
    }
  }

  private manifestPath(callId: string): string {
    return join(this.sessionDirectory(callId), 'manifest.json');
  }

  private segmentsDirectory(callId: string): string {
    return join(this.sessionDirectory(callId), 'segments');
  }

  private resolveSegmentPath(callId: string, fileName: string): string {
    if (!SEGMENT_FILE_NAME_PATTERN.test(fileName)) {
      throw new CheckpointIntegrityError('Checkpoint segment filename was invalid');
    }
    const segmentDirectory = resolve(this.segmentsDirectory(callId));
    const filePath = resolve(segmentDirectory, fileName);
    if (dirname(filePath) !== segmentDirectory) {
      throw new CheckpointIntegrityError('Checkpoint segment path escaped its directory');
    }
    return filePath;
  }

  private sessionDirectory(callId: string): string {
    return join(this.rootDirectory, CallIdSchema.parse(callId));
  }

  private async ensureCheckpointRootDirectory(): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true });
    await assertDirectoryNotSymlink(this.rootDirectory, 'checkpoint root');
  }

  private async assertExistingCheckpointRootDirectory(): Promise<void> {
    await assertDirectoryNotSymlink(this.rootDirectory, 'checkpoint root');
  }

  private async assertCheckpointSessionDirectory(callId: string): Promise<void> {
    await this.assertExistingCheckpointRootDirectory();
    const sessionDirectory = this.sessionDirectory(callId);
    await assertDirectoryNotSymlink(sessionDirectory, 'checkpoint session');
    await assertPathWithinDirectory(this.rootDirectory, sessionDirectory);
  }

  private async assertCheckpointSegmentsDirectory(callId: string): Promise<void> {
    await this.assertCheckpointSessionDirectory(callId);
    const segmentsDirectory = this.segmentsDirectory(callId);
    await assertDirectoryNotSymlink(segmentsDirectory, 'checkpoint segments');
    await assertPathWithinDirectory(this.sessionDirectory(callId), segmentsDirectory);
  }

  private async ensureRecoveredRootDirectory(): Promise<void> {
    await mkdir(this.recoveredDirectory, { recursive: true });
    await assertDirectoryNotSymlink(this.recoveredDirectory, 'recovered audio root');
  }
}

export const audioCheckpointStore = new EncryptedAudioCheckpointStore();

function normalizeManifestForRead(manifest: CheckpointManifest): CheckpointManifest {
  return {
    ...manifest,
    ownerUserId: manifest.ownerUserId ?? null,
    ownerMembershipId: manifest.ownerMembershipId ?? null,
    pendingAuditEntry: manifest.pendingAuditEntry ?? null,
  };
}

function normalizeManifestForWrite(
  manifest: UnsignedCheckpointManifest,
): UnsignedCheckpointManifest {
  return {
    ...manifest,
    ownerUserId: manifest.ownerUserId ?? null,
    ownerMembershipId: manifest.ownerMembershipId ?? null,
    pendingAuditEntry: manifest.pendingAuditEntry ?? null,
  };
}

function validateManifestInvariants(
  manifest: UnsignedCheckpointManifest | CheckpointManifest,
): void {
  let chunkCount = 0;
  let callBytes = 0;
  let durationMs = 0;
  const speakerBytes: Record<Speaker, number> = { self: 0, counterpart: 0 };

  for (const [position, segment] of manifest.segments.entries()) {
    if (segment.index !== position || segment.fileName !== expectedSegmentFileName(position)) {
      throw new CheckpointIntegrityError('Checkpoint segment order was invalid');
    }
    chunkCount += segment.chunkCount;
    callBytes += segment.byteLength;
    speakerBytes[segment.speaker] += segment.byteLength;
    durationMs = Math.max(durationMs, segment.startMs + segment.durationMs);
    if (
      callBytes > MAX_CALL_BYTES ||
      speakerBytes[segment.speaker] > MAX_SPEAKER_BYTES
    ) {
      throw new CheckpointQuotaError('Checkpoint manifest exceeded the safety quota');
    }
  }

  if (manifest.chunkCount !== chunkCount || manifest.durationMs !== durationMs) {
    throw new CheckpointIntegrityError('Checkpoint manifest totals were invalid');
  }
}

function estimateRecoveredWavBytes(manifest: CheckpointManifest): number {
  const speakers = new Set(manifest.segments.map((segment) => segment.speaker));
  const pcmBytes = manifest.segments.reduce((sum, segment) => sum + segment.byteLength, 0);
  return pcmBytes + speakers.size * 44;
}

function decodePcm(base64Audio: string): Buffer {
  const decoded = Buffer.from(base64Audio, 'base64');
  if (decoded.byteLength === 0) {
    throw new Error('Audio checkpoint chunk was empty');
  }
  return decoded;
}

function prepareCheckpointChunk(chunk: AudioChunk): PreparedCheckpointChunk {
  const pcm = decodePcm(chunk.data);
  if (pcm.byteLength > MAX_CHUNK_BYTES) {
    throw new CheckpointQuotaError('Audio checkpoint chunk exceeded the segment limit');
  }
  return { chunk, pcm };
}

function wrapSessionKey(sessionKey: Buffer): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage encryption is not available');
  }
  return safeStorage.encryptString(sessionKey.toString('base64')).toString('base64');
}

function unwrapSessionKey(wrappedSessionKey: string): Buffer {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage encryption is not available');
  }
  const unwrapped = safeStorage.decryptString(Buffer.from(wrappedSessionKey, 'base64'));
  const sessionKey = Buffer.from(unwrapped, 'base64');
  if (sessionKey.byteLength !== 32) {
    throw new CheckpointIntegrityError('Checkpoint session key is invalid');
  }
  return sessionKey;
}

function createManifestHmac(
  manifest: UnsignedCheckpointManifest,
  sessionKey: Buffer,
): string {
  return createHmac('sha256', sessionKey).update(canonicalJson(manifest)).digest('base64');
}

function withoutManifestHmac(manifest: CheckpointManifest): UnsignedCheckpointManifest {
  const { manifestHmac, ...unsignedManifest } = manifest;
  void manifestHmac;
  return unsignedManifest;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('Unsupported manifest value');
}

function segmentAad(
  manifest: Pick<CheckpointManifest, 'version' | 'callId'>,
  segment: Pick<
    CheckpointSegmentManifest,
    'index' | 'speaker' | 'startMs' | 'durationMs' | 'chunkCount' | 'byteLength'
  >,
): Buffer {
  return Buffer.from(
    canonicalJson({
      version: manifest.version,
      callId: manifest.callId,
      index: segment.index,
      speaker: segment.speaker,
      startMs: segment.startMs,
      durationMs: segment.durationMs,
      chunkCount: segment.chunkCount,
      byteLength: segment.byteLength,
    }),
  );
}

function buildMonoWavHeader(pcmByteLength: number): Buffer {
  if (pcmByteLength > 0xffffffff - 36) {
    throw new CheckpointQuotaError('Recovered WAV exceeded the format limit');
  }
  const byteRate = AUDIO_SAMPLE_RATE * AUDIO_CHANNELS * (AUDIO_BITS_PER_SAMPLE / 8);
  const blockAlign = AUDIO_CHANNELS * (AUDIO_BITS_PER_SAMPLE / 8);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcmByteLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(AUDIO_CHANNELS, 22);
  header.writeUInt32LE(AUDIO_SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(AUDIO_BITS_PER_SAMPLE, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcmByteLength, 40);
  return header;
}

async function writeBuffer(
  handle: FileHandle,
  buffer: Buffer,
  position: number | null,
): Promise<void> {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const result = await handle.write(
      buffer,
      offset,
      buffer.byteLength - offset,
      position === null ? null : position + offset,
    );
    if (result.bytesWritten <= 0) {
      throw new Error('Failed to write recovered WAV');
    }
    offset += result.bytesWritten;
  }
}

async function closeTargets(targets: Map<Speaker, StreamingWavTarget>): Promise<void> {
  await Promise.all(
    Array.from(targets.values()).map(async (target) => {
      await target.handle.close().catch(() => undefined);
      await rm(target.temporaryPath, { force: true }).catch(() => undefined);
    }),
  );
}

async function safeRemoveDirectory(directory: string, label: string): Promise<void> {
  const directoryStats = await lstat(directory).catch((error) => {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  });
  if (!directoryStats) {
    return;
  }
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new CheckpointIntegrityError(`${label} path was not a regular directory`);
  }
  await rm(directory, { recursive: true, force: true });
}

async function assertDirectoryNotSymlink(directory: string, label: string): Promise<void> {
  const directoryStats = await lstat(directory);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new CheckpointIntegrityError(`${label} path was not a regular directory`);
  }
}

async function assertDirectoryNotSymlinkIfExists(directory: string, label: string): Promise<void> {
  const directoryStats = await lstat(directory).catch((error) => {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  });
  if (!directoryStats) {
    return;
  }
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new CheckpointIntegrityError(`${label} path was not a regular directory`);
  }
}

async function assertFileNotSymlink(filePath: string, label: string): Promise<void> {
  const fileStats = await lstat(filePath);
  if (!fileStats.isFile() || fileStats.isSymbolicLink()) {
    throw new CheckpointIntegrityError(`${label} path was not a regular file`);
  }
}

async function assertPathWithinDirectory(parentDirectory: string, childPath: string): Promise<void> {
  const parent = await realpath(parentDirectory);
  const child = await realpath(childPath);
  if (child !== parent && !child.startsWith(`${parent}${sep}`)) {
    throw new CheckpointIntegrityError('Checkpoint path escaped its directory');
  }
}

async function sumDirectoryFileBytes(directory: string): Promise<number> {
  const directoryStats = await lstat(directory).catch((error) => {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  });
  if (!directoryStats) {
    return 0;
  }
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new CheckpointIntegrityError('Audio storage path was not a regular directory');
  }

  let total = 0;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    const entryStats = await lstat(entryPath);
    if (entryStats.isSymbolicLink()) {
      continue;
    }
    if (entryStats.isDirectory()) {
      total += await sumDirectoryFileBytes(entryPath);
    } else if (entryStats.isFile()) {
      total += entryStats.size;
    }
  }
  return total;
}

function expectedSegmentFileName(index: number): string {
  return `segment-${String(index).padStart(6, '0')}.bin`;
}

function addDays(date: Date, days: RecoveryRetentionDays): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1_000);
}

function sortedSpeakers(speakers: Speaker[]): Speaker[] {
  const order: Record<Speaker, number> = { self: 0, counterpart: 1 };
  return [...speakers].sort((left, right) => order[left] - order[right]);
}

function defaultUserDataPath(): string {
  return process.env.SALES_TALK_USER_DATA_PATH ?? app?.getPath?.('userData') ?? process.cwd();
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Unknown audio checkpoint error');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
