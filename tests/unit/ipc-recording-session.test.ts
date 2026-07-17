import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { BrowserWindow } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../src/shared/ipc-channels';
import type { RecordingConsent } from '../../src/shared/types';

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
  method: 'verbal',
  capturedAt: '2026-07-15T00:00:00.000Z',
  noticeVersion: 'unit-test',
};

describe('startRecordingSession partial failure', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('plans audit-failure cleanup without exposing raw errors', async () => {
    const { createRecordingStartFailureCleanupPlan } = await import('../../src/main/ipc/index');

    expect(
      createRecordingStartFailureCleanupPlan({
        reason: 'call_audit_failed',
        callId: '00000000-0000-4000-8000-000000000123',
      }),
    ).toEqual({
      stopAudioServices: true,
      resetPreflight: true,
      endCallId: '00000000-0000-4000-8000-000000000123',
      userMessage:
        '録音監査ログの記録に失敗したため、録音を開始できませんでした。時間をおいて再試行してください。',
    });

    expect(
      createRecordingStartFailureCleanupPlan({ reason: 'diagnostic_audit_failed' }),
    ).toMatchObject({
      stopAudioServices: true,
      resetPreflight: true,
      endCallId: null,
    });
  });

  it('records the authorized attempt and removes an empty checkpoint when native capture fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-ipc-recording-'));
    const nativeModulePath = join(directory, 'audio_capture.cjs');
    await writeFile(join(directory, 'settings.json'), JSON.stringify(testSettings()), 'utf8');
    await writeFile(
      nativeModulePath,
      `
exports.onAudioChunk = () => {};
exports.onError = () => {};
exports.startCapture = async () => {
  throw new Error('raw-secret-native-start-failure');
};
exports.stopCapture = async () => {};
`,
      'utf8',
    );

    vi.stubEnv('SALES_TALK_USER_DATA_PATH', directory);
    vi.stubEnv('SALES_TALK_FORCE_AUDIO_PERMISSIONS', '1');
    vi.stubEnv('SALES_TALK_AUDIO_CAPTURE_MODULE', nativeModulePath);

    try {
      const send = vi.fn();
      const { startRecordingSession } = await import('../../src/main/ipc/index');
      const { appRepositories } = await import('../../src/main/services/repositories');

      const result = await startRecordingSession(
        {
          getControlWindow: () => fakeControlWindow(send),
          getOverlayWindow: () => null,
        },
        {
          productId: 'real_estate',
          consent: grantedConsent,
          source: 'zoom_desktop',
        },
      );

      const context = await appRepositories.organizations.getCurrentContext();
      const auditLogs = await appRepositories.auditLogs.listAuditLogs({
        tenantId: context.tenant.id,
        organizationId: context.organization.id,
      });
      const audioErrors = send.mock.calls
        .filter(([channel]) => channel === IPC.audio.onError)
        .map(([, message]) => String(message));

      await expect(appRepositories.calls.listCalls()).resolves.toMatchObject([
        { status: 'ended', endedAt: expect.any(String) },
      ]);
      expect(auditLogs.map((entry) => entry.action)).toEqual(
        expect.arrayContaining([
          'recording.consent_captured',
          'recording.started',
          'checkpoint.discarded',
        ]),
      );
      expect(result).toEqual({ ok: false, error: 'start_failed' });
      expect(audioErrors.join('\n')).toContain('録音の開始に失敗しました。');
      expect(audioErrors.join('\n')).not.toContain('raw-secret-native-start-failure');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('ends the created call and stops audio when audit logging fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-ipc-audit-fail-'));
    const nativeModulePath = join(directory, 'audio_capture.cjs');
    const nativeLogPath = join(directory, 'native.log');
    await writeFile(join(directory, 'settings.json'), JSON.stringify(testSettings()), 'utf8');
    await writeFile(
      nativeModulePath,
      `
const { appendFileSync } = require('node:fs');
const nativeLogPath = ${JSON.stringify(nativeLogPath)};
exports.onAudioChunk = () => {};
exports.onError = () => {};
exports.startCapture = async () => {
  appendFileSync(nativeLogPath, 'start\\n');
  return { sessionId: 'session-1' };
};
exports.stopCapture = async () => {
  appendFileSync(nativeLogPath, 'stop\\n');
};
`,
      'utf8',
    );

    vi.stubEnv('SALES_TALK_USER_DATA_PATH', directory);
    vi.stubEnv('SALES_TALK_FORCE_AUDIO_PERMISSIONS', '1');
    vi.stubEnv('SALES_TALK_AUDIO_CAPTURE_MODULE', nativeModulePath);

    try {
      const send = vi.fn();
      const { getActiveRecordingCallId, startRecordingSession } = await import(
        '../../src/main/ipc/index'
      );
      const { appRepositories } = await import('../../src/main/services/repositories');
      vi.spyOn(appRepositories.auditLogs, 'appendAuditLogs').mockRejectedValueOnce(
        new Error('raw-secret-audit-failure'),
      );

      const result = await startRecordingSession(
        {
          getControlWindow: () => fakeControlWindow(send),
          getOverlayWindow: () => null,
        },
        {
          productId: 'real_estate',
          consent: grantedConsent,
          source: 'zoom_desktop',
        },
      );
      const audioErrors = send.mock.calls
        .filter(([channel]) => channel === IPC.audio.onError)
        .map(([, message]) => String(message));
      const calls = await appRepositories.calls.listCalls();

      expect(result).toEqual({ ok: false, error: 'start_failed' });
      expect(getActiveRecordingCallId()).toBeNull();
      expect(calls).toHaveLength(1);
      expect(calls[0]!).toMatchObject({ status: 'ended', endedAt: expect.any(String) });
      expect(readText(nativeLogPath)).toBe('');
      expect(audioErrors.join('\n')).toContain('録音監査ログの記録に失敗したため');
      expect(audioErrors.join('\n')).not.toContain('raw-secret-audit-failure');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('persists diagnostic audit logs before native audio capture starts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-ipc-diagnostic-audit-fail-'));
    const nativeModulePath = join(directory, 'audio_capture.cjs');
    const nativeLogPath = join(directory, 'native.log');
    await writeFile(join(directory, 'settings.json'), JSON.stringify(testSettings()), 'utf8');
    await writeFile(
      nativeModulePath,
      `
const { appendFileSync } = require('node:fs');
const nativeLogPath = ${JSON.stringify(nativeLogPath)};
exports.onAudioChunk = () => {};
exports.onError = () => {};
exports.startCapture = async () => {
  appendFileSync(nativeLogPath, 'start\\n');
  return { sessionId: 'diagnostic-session' };
};
exports.stopCapture = async () => {
  appendFileSync(nativeLogPath, 'stop\\n');
};
`,
      'utf8',
    );

    vi.stubEnv('SALES_TALK_USER_DATA_PATH', directory);
    vi.stubEnv('SALES_TALK_FORCE_AUDIO_PERMISSIONS', '1');
    vi.stubEnv('SALES_TALK_AUDIO_CAPTURE_MODULE', nativeModulePath);

    try {
      const { startAudioDiagnosticSession } = await import('../../src/main/ipc/index');
      const { appRepositories } = await import('../../src/main/services/repositories');
      vi.spyOn(appRepositories.auditLogs, 'appendAuditLogs').mockRejectedValueOnce(
        new Error('audit unavailable'),
      );

      const result = await startAudioDiagnosticSession(
        {
          getControlWindow: () => fakeControlWindow(vi.fn()),
          getOverlayWindow: () => null,
        },
        grantedConsent,
      );

      expect(result).toEqual({ ok: false, error: 'start_failed' });
      expect(readText(nativeLogPath)).toBe('');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('finalizes checkpoint audio assets before deleting a normally ended checkpoint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-ipc-finalize-'));
    const nativeModulePath = join(directory, 'audio_capture.cjs');
    await writeFile(join(directory, 'settings.json'), JSON.stringify(testSettings()), 'utf8');
    await writeFile(
      nativeModulePath,
      `
let audioCallback = null;
exports.onAudioChunk = (callback) => { audioCallback = callback; };
exports.onError = () => {};
exports.startCapture = async () => {
  audioCallback?.({
    source: 'microphone',
    data: Buffer.from([1, 2, 3, 4]),
    timestamp: 1700000000000,
    durationMs: 5000,
    sampleRate: 16000,
  });
  return { sessionId: 'session-1' };
};
exports.stopCapture = async () => {};
`,
      'utf8',
    );

    vi.stubEnv('SALES_TALK_USER_DATA_PATH', directory);
    vi.stubEnv('SALES_TALK_FORCE_AUDIO_PERMISSIONS', '1');
    vi.stubEnv('SALES_TALK_AUDIO_CAPTURE_MODULE', nativeModulePath);

    try {
      const { startRecordingSession, stopRecordingSession } = await import(
        '../../src/main/ipc/index'
      );
      const { appRepositories } = await import('../../src/main/services/repositories');
      const { audioCheckpointStore } = await import('../../src/main/services/audio-checkpoint-store');
      const windows = {
        getControlWindow: () => fakeControlWindow(vi.fn()),
        getOverlayWindow: () => null,
      };

      const started = await startRecordingSession(windows, {
        productId: 'real_estate',
        consent: grantedConsent,
        source: 'zoom_desktop',
      });
      expect(started.ok).toBe(true);
      if (!started.ok) {
        throw new Error('Recording did not start');
      }

      const context = await appRepositories.organizations.getCurrentContext();
      await expect(audioCheckpointStore.getSummary(started.callId)).resolves.toMatchObject({
        ownerUserId: context.user.id,
        ownerMembershipId: context.membership.id,
      });

      await stopRecordingSession(windows);

      await expect(appRepositories.audioAssets.listAudioAssets(started.callId)).resolves.toMatchObject([
        { callId: started.callId, fileName: `${started.callId}-self.wav`, mimeType: 'audio/wav' },
      ]);
      await expect(audioCheckpointStore.getSummary(started.callId)).resolves.toBeNull();
      await expect(appRepositories.calls.listCalls()).resolves.toMatchObject([
        { id: started.callId, status: 'ended', endedAt: expect.any(String) },
      ]);
      const auditLogs = await appRepositories.auditLogs.listAuditLogs({
        tenantId: context.tenant.id,
        organizationId: context.organization.id,
      });
      expect(auditLogs.map((entry) => entry.action)).toContain('checkpoint.finalized');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

function fakeControlWindow(send: ReturnType<typeof vi.fn>): BrowserWindow {
  return { webContents: { send } } as unknown as BrowserWindow;
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
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
