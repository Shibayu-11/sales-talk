import { createHmac } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditLogEntry, CallSession } from '../../src/shared/types';
import {
  CheckpointQuotaError,
  CheckpointIntegrityError,
  EncryptedAudioCheckpointStore,
} from '../../src/main/services/audio-checkpoint-store';

vi.mock('electron', () => ({
  app: {
    getPath: () => process.env.SALES_TALK_USER_DATA_PATH ?? process.cwd(),
    getVersion: () => '0.0.0-test',
    isPackaged: false,
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`wrapped:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^wrapped:/, ''),
  },
}));

describe('EncryptedAudioCheckpointStore', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('stores encrypted segments without plaintext PCM or audio base64 in the manifest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-checkpoint-'));
    const store = new EncryptedAudioCheckpointStore(
      join(directory, 'checkpoints'),
      join(directory, 'recovered'),
    );
    const call = testCall();
    const pcm = Buffer.from([1, 2, 3, 4, 5, 6]);

    try {
      const sink = await store.beginRecording({
        call,
        ownerUserId: '00000000-0000-4000-8000-000000000004',
        ownerMembershipId: '00000000-0000-4000-8000-000000000005',
        now: new Date('2026-07-18T00:00:00.000Z'),
      });
      await sink.write({
        speaker: 'self',
        data: pcm.toString('base64'),
        startMs: 0,
        durationMs: 5_000,
      });
      await sink.drain();

      const manifestText = await readFile(
        join(directory, 'checkpoints', call.id, 'manifest.json'),
        'utf8',
      );
      const segmentFiles = await readdir(join(directory, 'checkpoints', call.id, 'segments'));
      const encrypted = await readFile(
        join(directory, 'checkpoints', call.id, 'segments', segmentFiles[0]!),
      );

      expect(manifestText).not.toContain(pcm.toString('base64'));
      expect(encrypted.includes(pcm)).toBe(false);
      expect(await store.listSummaries()).toMatchObject([
        {
          callId: call.id,
          state: 'recoverable',
          chunkCount: 1,
          ownerUserId: '00000000-0000-4000-8000-000000000004',
          ownerMembershipId: '00000000-0000-4000-8000-000000000005',
          availableSpeakers: ['self'],
        },
      ]);

      const recovered = await store.recoverToWavFiles(call.id);
      const wav = await readFile(recovered.wavFiles[0]!.filePath);
      expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(wav.subarray(44)).toEqual(pcm);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('detects ciphertext tampering and marks the checkpoint partial', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-checkpoint-tamper-'));
    const store = new EncryptedAudioCheckpointStore(
      join(directory, 'checkpoints'),
      join(directory, 'recovered'),
    );
    const call = testCall();

    try {
      const sink = await store.beginRecording({ call });
      await sink.write({
        speaker: 'counterpart',
        data: Buffer.from([9, 8, 7, 6]).toString('base64'),
        startMs: 100,
        durationMs: 5_000,
      });
      await sink.drain();

      const segmentDirectory = join(directory, 'checkpoints', call.id, 'segments');
      const segmentFiles = await readdir(segmentDirectory);
      const segmentPath = join(segmentDirectory, segmentFiles[0]!);
      const encrypted = await readFile(segmentPath);
      encrypted[0] = (encrypted[0] ?? 0) ^ 0xff;
      await writeFile(segmentPath, encrypted);

      await expect(store.recoverToWavFiles(call.id)).rejects.toBeInstanceOf(
        CheckpointIntegrityError,
      );
      await expect(store.getSummary(call.id)).resolves.toMatchObject({ state: 'partial' });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('flushes sub-threshold chunks only when drained', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-checkpoint-drain-'));
    const store = new EncryptedAudioCheckpointStore(
      join(directory, 'checkpoints'),
      join(directory, 'recovered'),
    );
    const call = testCall();

    try {
      const sink = await store.beginRecording({ call });
      await sink.write({
        speaker: 'self',
        data: Buffer.from([1, 1]).toString('base64'),
        startMs: 0,
        durationMs: 100,
      });

      await expect(store.getSummary(call.id)).resolves.toMatchObject({ chunkCount: 0 });
      await sink.drain();
      await expect(store.getSummary(call.id)).resolves.toMatchObject({ chunkCount: 1 });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('authenticates manifest scope and rejects organization tampering', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-checkpoint-manifest-'));
    const store = new EncryptedAudioCheckpointStore(
      join(directory, 'checkpoints'),
      join(directory, 'recovered'),
    );
    const call = testCall();

    try {
      const sink = await store.beginRecording({ call });
      await sink.write({
        speaker: 'self',
        data: Buffer.from([1, 2]).toString('base64'),
        startMs: 0,
        durationMs: 5_000,
      });
      await sink.drain();

      const manifestPath = join(directory, 'checkpoints', call.id, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        organizationId: string;
      };
      manifest.organizationId = '00000000-0000-4000-8000-000000000099';
      await writeFile(manifestPath, JSON.stringify(manifest));

      await expect(store.getSummary(call.id)).rejects.toBeInstanceOf(CheckpointIntegrityError);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('normalizes native epoch timestamps to session-relative duration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-checkpoint-timeline-'));
    const store = new EncryptedAudioCheckpointStore(
      join(directory, 'checkpoints'),
      join(directory, 'recovered'),
    );
    const call = testCall();

    try {
      const sink = await store.beginRecording({ call });
      await sink.write({
        speaker: 'self',
        data: Buffer.from([1, 2]).toString('base64'),
        startMs: 1_700_000_000_000,
        durationMs: 100,
      });
      await sink.write({
        speaker: 'counterpart',
        data: Buffer.from([3, 4]).toString('base64'),
        startMs: 1_700_000_005_000,
        durationMs: 100,
      });
      await sink.drain();

      await expect(store.getSummary(call.id)).resolves.toMatchObject({ durationMs: 5_100 });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('fails deterministically when checkpoint writes exceed bounded backpressure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-checkpoint-backpressure-'));
    const store = new EncryptedAudioCheckpointStore(
      join(directory, 'checkpoints'),
      join(directory, 'recovered'),
    );
    const call = testCall();

    try {
      const sink = await store.beginRecording({ call });
      const writes = Array.from({ length: 40 }, (_unused, index) =>
        sink.write({
          speaker: 'self',
          data: Buffer.from([index]).toString('base64'),
          startMs: index,
          durationMs: 1,
        }),
      );

      const results = await Promise.allSettled(writes);
      expect(
        results.some(
          (result) =>
            result.status === 'rejected' && result.reason instanceof CheckpointQuotaError,
        ),
      ).toBe(true);
      await expect(sink.drain()).rejects.toBeInstanceOf(CheckpointQuotaError);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('rejects symlinked checkpoint roots before writing or deleting', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-checkpoint-symlink-'));
    const realRoot = join(directory, 'real-root');
    const rootLink = join(directory, 'root-link');
    await writeFile(join(directory, 'placeholder'), 'x');
    await rm(realRoot, { force: true, recursive: true });
    await symlink(directory, rootLink);
    const store = new EncryptedAudioCheckpointStore(rootLink, join(directory, 'recovered'));

    try {
      await expect(store.beginRecording({ call: testCall() })).rejects.toBeInstanceOf(
        CheckpointIntegrityError,
      );
      await expect(store.discard(testCall().id)).rejects.toBeInstanceOf(CheckpointIntegrityError);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('persists, reloads, and clears authenticated pending retention audit entries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-checkpoint-pending-audit-'));
    const checkpoints = join(directory, 'checkpoints');
    const recovered = join(directory, 'recovered');
    const store = new EncryptedAudioCheckpointStore(checkpoints, recovered);
    const call = testCall();
    const auditEntry = createAuditEntry(call.id);

    try {
      const sink = await store.beginRecording({ call });
      await sink.drain();
      const updated = await store.stageRetention(call.id, 30, auditEntry);
      expect(updated.retentionDays).toBe(30);

      const reloaded = new EncryptedAudioCheckpointStore(checkpoints, recovered);
      const pendingAuditEntry = await reloaded.getPendingAuditEntry(call.id);
      expect(pendingAuditEntry).toMatchObject({
        id: auditEntry.id,
        action: 'checkpoint.retention_updated',
      });
      expect(pendingAuditEntry?.metadata.expiresAt).toBe(updated.expiresAt);
      await expect(reloaded.completePendingAudit(call.id, 'wrong-id')).rejects.toBeInstanceOf(
        CheckpointIntegrityError,
      );
      await reloaded.completePendingAudit(call.id, auditEntry.id);

      const cleared = new EncryptedAudioCheckpointStore(checkpoints, recovered);
      await expect(cleared.getPendingAuditEntry(call.id)).resolves.toBeNull();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('authenticates old manifests that omitted owner and pending audit fields', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-checkpoint-old-manifest-'));
    const checkpoints = join(directory, 'checkpoints');
    const store = new EncryptedAudioCheckpointStore(checkpoints, join(directory, 'recovered'));
    const call = testCall();

    try {
      const sink = await store.beginRecording({ call });
      await sink.drain();

      const manifestPath = join(checkpoints, call.id, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
      const wrappedSessionKey = String(manifest.wrappedSessionKey);
      delete manifest.manifestHmac;
      delete manifest.ownerUserId;
      delete manifest.ownerMembershipId;
      delete manifest.pendingAuditEntry;
      const sessionKey = Buffer.from(
        Buffer.from(wrappedSessionKey, 'base64').toString('utf8').replace(/^wrapped:/, ''),
        'base64',
      );
      manifest.manifestHmac = createHmac('sha256', sessionKey)
        .update(canonicalJson(manifest))
        .digest('base64');
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      await expect(store.getSummary(call.id)).resolves.toMatchObject({
        ownerUserId: null,
        ownerMembershipId: null,
      });
      await expect(store.getPendingAuditEntry(call.id)).resolves.toBeNull();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

function testCall(): CallSession {
  const now = '2026-07-18T00:00:00.000Z';
  return {
    id: '00000000-0000-4000-8000-000000000123',
    tenantId: '00000000-0000-4000-8000-000000000001',
    organizationId: '00000000-0000-4000-8000-000000000002',
    source: 'zoom_desktop',
    industry: 'btob_sales',
    productId: 'real_estate',
    recordingConsent: {
      status: 'granted',
      method: 'digital',
      capturedAt: now,
      noticeVersion: 'unit-test',
    },
    status: 'active',
    startedAt: now,
    endedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function createAuditEntry(callId: string): AuditLogEntry {
  return {
    id: '00000000-0000-4000-8000-000000000201',
    tenantId: '00000000-0000-4000-8000-000000000001',
    organizationId: '00000000-0000-4000-8000-000000000002',
    actorType: 'user',
    actorUserId: '00000000-0000-4000-8000-000000000004',
    actorMembershipId: '00000000-0000-4000-8000-000000000005',
    actorDisplayName: 'Agency Admin',
    actorRole: 'agency_admin',
    action: 'checkpoint.retention_updated',
    targetType: 'call',
    targetId: callId,
    metadata: { retentionDays: 30 },
    previousHash: null,
    hash: null,
    createdAt: '2026-07-18T00:00:10.000Z',
  };
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
