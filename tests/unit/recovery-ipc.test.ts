import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CallSession,
  OrganizationRole,
  RecordingConsent,
} from '../../src/shared/types';
import {
  DEFAULT_AGENT_MEMBERSHIP_ID,
  DEFAULT_AGENT_USER_ID,
} from '../../src/shared/organization-constants';

vi.mock('electron', () => ({
  app: {
    getPath: () => process.env.SALES_TALK_USER_DATA_PATH ?? process.cwd(),
    getVersion: () => '0.0.0-test',
    isPackaged: false,
  },
  BrowserWindow: class BrowserWindow {},
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn(),
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`wrapped:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^wrapped:/, ''),
  },
  shell: {
    openExternal: vi.fn(),
  },
  systemPreferences: {
    askForMediaAccess: vi.fn(),
    getMediaAccessStatus: vi.fn(() => 'granted'),
  },
}));

const grantedConsent: RecordingConsent = {
  status: 'granted',
  method: 'digital',
  capturedAt: '2026-07-18T00:00:00.000Z',
  noticeVersion: 'unit-test',
};

describe('recovery IPC helpers', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('lists only checkpoints in the current tenant and organization', async () => {
    const directory = await setupUserData();
    vi.stubEnv('SALES_TALK_USER_DATA_PATH', directory);

    try {
      const { appRepositories } = await import('../../src/main/services/repositories');
      const { audioCheckpointStore } = await import('../../src/main/services/audio-checkpoint-store');
      const { listRecoverySummaries } = await import('../../src/main/ipc/index');
      const currentCall = await createCall(appRepositories.calls, {
        organizationId: '00000000-0000-4000-8000-000000000002',
      });
      const foreignCall = await createCall(appRepositories.calls, {
        organizationId: '00000000-0000-4000-8000-000000000099',
      });
      await writeCheckpoint(audioCheckpointStore, currentCall);
      await writeCheckpoint(audioCheckpointStore, foreignCall);

      await expect(listRecoverySummaries()).resolves.toMatchObject([
        { callId: currentCall.id, organizationId: currentCall.organizationId },
      ]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('filters ordinary agents to their owned checkpoints and keeps managers org-wide', async () => {
    const directory = await setupUserData();
    vi.stubEnv('SALES_TALK_USER_DATA_PATH', directory);

    try {
      const { appRepositories } = await import('../../src/main/services/repositories');
      const { audioCheckpointStore } = await import('../../src/main/services/audio-checkpoint-store');
      const { listRecoverySummaries } = await import('../../src/main/ipc/index');
      const context = await appRepositories.organizations.getCurrentContext();
      const ownedCall = await createCall(appRepositories.calls, {
        organizationId: context.organization.id,
      });
      const otherOwnedCall = await createCall(appRepositories.calls, {
        organizationId: context.organization.id,
      });
      const legacyCall = await createCall(appRepositories.calls, {
        organizationId: context.organization.id,
      });
      await writeCheckpoint(audioCheckpointStore, ownedCall, {
        ownerUserId: context.user.id,
        ownerMembershipId: context.membership.id,
      });
      await writeCheckpoint(audioCheckpointStore, otherOwnedCall, {
        ownerUserId: DEFAULT_AGENT_USER_ID,
        ownerMembershipId: DEFAULT_AGENT_MEMBERSHIP_ID,
      });
      await writeCheckpoint(audioCheckpointStore, legacyCall);

      await setCurrentRole(appRepositories.organizations, 'agent');
      await expect(listRecoverySummaries()).resolves.toMatchObject([{ callId: ownedCall.id }]);

      await setCurrentRole(appRepositories.organizations, 'manager');
      const managerVisibleCallIds = (await listRecoverySummaries()).map((summary) => summary.callId);
      expect(managerVisibleCallIds).toEqual(
        expect.arrayContaining([ownedCall.id, otherOwnedCall.id, legacyCall.id]),
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('denies agent mutation for foreign or legacy checkpoints while managers can manage them', async () => {
    const directory = await setupUserData();
    vi.stubEnv('SALES_TALK_USER_DATA_PATH', directory);

    try {
      const { appRepositories } = await import('../../src/main/services/repositories');
      const { audioCheckpointStore } = await import('../../src/main/services/audio-checkpoint-store');
      const { discardCheckpoint } = await import('../../src/main/ipc/index');
      const context = await appRepositories.organizations.getCurrentContext();
      const foreignOwnedCall = await createCall(appRepositories.calls, {
        organizationId: context.organization.id,
      });
      const legacyCall = await createCall(appRepositories.calls, {
        organizationId: context.organization.id,
      });
      await writeCheckpoint(audioCheckpointStore, foreignOwnedCall, {
        ownerUserId: DEFAULT_AGENT_USER_ID,
        ownerMembershipId: DEFAULT_AGENT_MEMBERSHIP_ID,
      });
      await writeCheckpoint(audioCheckpointStore, legacyCall);

      await setCurrentRole(appRepositories.organizations, 'agent');
      await expect(discardCheckpoint(foreignOwnedCall.id)).rejects.toThrow(
        'この録音 checkpoint を操作する権限がありません。',
      );
      await expect(discardCheckpoint(legacyCall.id)).rejects.toThrow(
        'この録音 checkpoint を操作する権限がありません。',
      );

      await setCurrentRole(appRepositories.organizations, 'manager');
      await expect(discardCheckpoint(legacyCall.id)).resolves.toBeUndefined();
      await expect(audioCheckpointStore.getSummary(legacyCall.id)).resolves.toBeNull();
      await expect(audioCheckpointStore.getSummary(foreignOwnedCall.id)).resolves.toMatchObject({
        callId: foreignOwnedCall.id,
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('allows auditors to list organization checkpoints but not mutate them', async () => {
    const directory = await setupUserData();
    vi.stubEnv('SALES_TALK_USER_DATA_PATH', directory);

    try {
      const { appRepositories } = await import('../../src/main/services/repositories');
      const { audioCheckpointStore } = await import('../../src/main/services/audio-checkpoint-store');
      const { discardCheckpoint, listRecoverySummaries } = await import('../../src/main/ipc/index');
      const context = await appRepositories.organizations.getCurrentContext();
      const call = await createCall(appRepositories.calls, {
        organizationId: context.organization.id,
      });
      await writeCheckpoint(audioCheckpointStore, call);

      await setCurrentRole(appRepositories.organizations, 'auditor');
      await expect(listRecoverySummaries()).resolves.toMatchObject([{ callId: call.id }]);
      await expect(discardCheckpoint(call.id)).rejects.toThrow(
        'Current user does not have permission: checkpoints:manage',
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('requires calls:read permission before listing checkpoints', async () => {
    const directory = await setupUserData();
    vi.stubEnv('SALES_TALK_USER_DATA_PATH', directory);

    try {
      const { appRepositories } = await import('../../src/main/services/repositories');
      const { listRecoverySummaries } = await import('../../src/main/ipc/index');
      vi.spyOn(appRepositories.organizations, 'assertPermission').mockRejectedValueOnce(
        new Error('permission denied'),
      );

      await expect(listRecoverySummaries()).rejects.toThrow('permission denied');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('does not discard checkpoints when audit logging fails', async () => {
    const directory = await setupUserData();
    vi.stubEnv('SALES_TALK_USER_DATA_PATH', directory);

    try {
      const { appRepositories } = await import('../../src/main/services/repositories');
      const { audioCheckpointStore } = await import('../../src/main/services/audio-checkpoint-store');
      const { discardCheckpoint, listRecoverySummaries } = await import('../../src/main/ipc/index');
      const call = await createCall(appRepositories.calls, {
        organizationId: '00000000-0000-4000-8000-000000000002',
      });
      await writeCheckpoint(audioCheckpointStore, call);
      vi.spyOn(appRepositories.auditLogs, 'appendAuditLogs').mockRejectedValueOnce(
        new Error('audit failed'),
      );

      await expect(discardCheckpoint(call.id)).rejects.toThrow('audit failed');
      await expect(listRecoverySummaries()).resolves.toMatchObject([{ callId: call.id }]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('deletes expired checkpoints autonomously after a system audit without manage permission', async () => {
    const directory = await setupUserData();
    vi.stubEnv('SALES_TALK_USER_DATA_PATH', directory);

    try {
      const { appRepositories } = await import('../../src/main/services/repositories');
      const { audioCheckpointStore } = await import('../../src/main/services/audio-checkpoint-store');
      const { listRecoverySummaries } = await import('../../src/main/ipc/index');
      const context = await appRepositories.organizations.getCurrentContext();
      const call = await createCall(appRepositories.calls, {
        organizationId: context.organization.id,
      });
      await writeCheckpoint(audioCheckpointStore, call, {
        now: new Date('2020-01-01T00:00:00.000Z'),
      });
      await setCurrentRole(appRepositories.organizations, 'auditor');
      const assertPermissionSpy = vi.spyOn(appRepositories.organizations, 'assertPermission');

      await expect(listRecoverySummaries()).resolves.toEqual([]);
      expect(assertPermissionSpy).not.toHaveBeenCalledWith('checkpoints:manage');
      await expect(audioCheckpointStore.getSummary(call.id)).resolves.toBeNull();
      const auditorContext = await appRepositories.organizations.getCurrentContext();
      const auditLogs = await appRepositories.auditLogs.listAuditLogs({
        tenantId: auditorContext.tenant.id,
        organizationId: auditorContext.organization.id,
      });
      expect(auditLogs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'checkpoint.expired',
            actorType: 'system',
            tenantId: call.tenantId,
            organizationId: call.organizationId,
            metadata: expect.objectContaining({ operationId: expect.any(String) }),
          }),
        ]),
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('leaves staged retention pending when audit fails and replays it idempotently', async () => {
    const directory = await setupUserData();
    vi.stubEnv('SALES_TALK_USER_DATA_PATH', directory);

    try {
      const { appRepositories } = await import('../../src/main/services/repositories');
      const { audioCheckpointStore } = await import('../../src/main/services/audio-checkpoint-store');
      const { runCheckpointMaintenance, updateCheckpointRetention } = await import(
        '../../src/main/ipc/index'
      );
      const context = await appRepositories.organizations.getCurrentContext();
      const call = await createCall(appRepositories.calls, {
        organizationId: context.organization.id,
      });
      await writeCheckpoint(audioCheckpointStore, call);
      vi.spyOn(appRepositories.auditLogs, 'appendAuditLogs').mockRejectedValueOnce(
        new Error('audit failed'),
      );

      await expect(updateCheckpointRetention(call.id, 30)).rejects.toThrow('audit failed');
      await expect(audioCheckpointStore.getSummary(call.id)).resolves.toMatchObject({
        retentionDays: 30,
      });
      await expect(audioCheckpointStore.getPendingAuditEntry(call.id)).resolves.toMatchObject({
        action: 'checkpoint.retention_updated',
      });

      await runCheckpointMaintenance();
      await expect(audioCheckpointStore.getPendingAuditEntry(call.id)).resolves.toBeNull();
      const auditLogs = await appRepositories.auditLogs.listAuditLogs({
        tenantId: context.tenant.id,
        organizationId: context.organization.id,
      });
      expect(auditLogs.filter((entry) => entry.action === 'checkpoint.retention_updated')).toHaveLength(
        1,
      );

      await runCheckpointMaintenance();
      const replayedAuditLogs = await appRepositories.auditLogs.listAuditLogs({
        tenantId: context.tenant.id,
        organizationId: context.organization.id,
      });
      expect(
        replayedAuditLogs.filter((entry) => entry.action === 'checkpoint.retention_updated'),
      ).toHaveLength(1);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('deduplicates destructive audit rows when deletion is retried after a crash', async () => {
    const directory = await setupUserData();
    vi.stubEnv('SALES_TALK_USER_DATA_PATH', directory);

    try {
      const { appRepositories } = await import('../../src/main/services/repositories');
      const { audioCheckpointStore } = await import('../../src/main/services/audio-checkpoint-store');
      const { discardCheckpoint } = await import('../../src/main/ipc/index');
      const context = await appRepositories.organizations.getCurrentContext();
      const call = await createCall(appRepositories.calls, {
        organizationId: context.organization.id,
      });
      await writeCheckpoint(audioCheckpointStore, call);
      vi.spyOn(audioCheckpointStore, 'discard').mockRejectedValueOnce(new Error('delete failed'));

      await expect(discardCheckpoint(call.id)).rejects.toThrow('delete failed');
      await expect(audioCheckpointStore.getSummary(call.id)).resolves.toMatchObject({
        callId: call.id,
      });
      await expect(discardCheckpoint(call.id)).resolves.toBeUndefined();
      await expect(audioCheckpointStore.getSummary(call.id)).resolves.toBeNull();

      const auditLogs = await appRepositories.auditLogs.listAuditLogs({
        tenantId: context.tenant.id,
        organizationId: context.organization.id,
      });
      expect(auditLogs.filter((entry) => entry.action === 'checkpoint.discarded')).toHaveLength(1);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

async function setupUserData(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sales-talk-recovery-ipc-'));
  await writeFile(join(directory, 'settings.json'), JSON.stringify(testSettings()), 'utf8');
  return directory;
}

async function createCall(
  calls: {
    createCall(input: {
      tenantId: string;
      organizationId: string;
      source: CallSession['source'];
      industry: CallSession['industry'];
      productId: CallSession['productId'];
      recordingConsent: RecordingConsent;
      startedAt?: Date | undefined;
    }): Promise<CallSession>;
  },
  input: { organizationId: string },
): Promise<CallSession> {
  return calls.createCall({
    tenantId: '00000000-0000-4000-8000-000000000001',
    organizationId: input.organizationId,
    source: 'zoom_desktop',
    industry: 'btob_sales',
    productId: 'real_estate',
    recordingConsent: grantedConsent,
    startedAt: new Date('2026-07-18T00:00:00.000Z'),
  });
}

async function writeCheckpoint(
  store: {
    beginRecording(input: {
      call: CallSession;
      ownerUserId?: string | null | undefined;
      ownerMembershipId?: string | null | undefined;
      now?: Date | undefined;
    }): Promise<{
      write(chunk: {
        speaker: 'self';
        data: string;
        startMs: number;
        durationMs: number;
      }): Promise<void>;
      drain(): Promise<void>;
    }>;
  },
  call: CallSession,
  input: {
    ownerUserId?: string | null | undefined;
    ownerMembershipId?: string | null | undefined;
    now?: Date | undefined;
  } = {},
): Promise<void> {
  const sink = await store.beginRecording({
    call,
    ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
    ...(input.ownerMembershipId !== undefined
      ? { ownerMembershipId: input.ownerMembershipId }
      : {}),
    ...(input.now ? { now: input.now } : {}),
  });
  await sink.write({
    speaker: 'self',
    data: Buffer.from([1, 2, 3, 4]).toString('base64'),
    startMs: 0,
    durationMs: 5_000,
  });
  await sink.drain();
}

async function setCurrentRole(
  organizations: {
    getCurrentContext(): Promise<{
      tenant: { id: string };
      membership: { id: string };
    }>;
    updateUserRole(
      tenantId: string,
      membershipId: string,
      role: OrganizationRole,
    ): Promise<unknown>;
  },
  role: OrganizationRole,
): Promise<void> {
  const context = await organizations.getCurrentContext();
  await organizations.updateUserRole(context.tenant.id, context.membership.id, role);
}

function testSettings() {
  return {
    selectedProductId: 'real_estate',
    overlayPosition: { x: 0, y: 80, display: 0 },
    hotkeys: {
      toggleOverlay: 'Option+Space',
      expandLayer3: 'Command+D',
      nextCandidate: 'Command+N',
      markUnused: 'Command+Shift+X',
    },
    consentNoticeMode: 'verbal',
    sttProviderMode: 'manual_only',
    sttImportProviderMode: 'local_first',
    onboardingCompletedAt: '2026-07-15T00:00:00.000Z',
    schemaVersion: 1,
  };
}
