import { describe, expect, it } from 'vitest';
import { evaluateAudioPreflight } from '../../src/main/audio/audio-preflight';
import type { AudioCaptureStats, ConnectionState, PermissionState } from '../../src/shared/types';

const grantedPermissions: PermissionState = { screen: true, microphone: true };
const validNativeModule = {
  available: true,
  contractValid: true,
  modulePath: '/tmp/audio_capture.node',
};

function stats(input: {
  selfChunks?: number;
  counterpartChunks?: number;
  selfLastReceivedAtMs?: number | null;
  counterpartLastReceivedAtMs?: number | null;
} = {}): AudioCaptureStats {
  const selfChunks = input.selfChunks ?? 0;
  const counterpartChunks = input.counterpartChunks ?? 0;
  const selfLastReceivedAtMs = input.selfLastReceivedAtMs ?? null;
  const counterpartLastReceivedAtMs = input.counterpartLastReceivedAtMs ?? null;
  const totalLastReceivedAtMs =
    selfLastReceivedAtMs === null
      ? counterpartLastReceivedAtMs
      : counterpartLastReceivedAtMs === null
        ? selfLastReceivedAtMs
        : Math.max(selfLastReceivedAtMs, counterpartLastReceivedAtMs);

  return {
    self: { chunks: selfChunks, bytes: selfChunks * 3200, lastReceivedAtMs: selfLastReceivedAtMs },
    counterpart: {
      chunks: counterpartChunks,
      bytes: counterpartChunks * 3200,
      lastReceivedAtMs: counterpartLastReceivedAtMs,
    },
    total: {
      chunks: selfChunks + counterpartChunks,
      bytes: (selfChunks + counterpartChunks) * 3200,
      lastReceivedAtMs: totalLastReceivedAtMs,
    },
  };
}

function report(input: {
  permissions?: PermissionState;
  nativeModule?: typeof validNativeModule;
  audioStats?: AudioCaptureStats;
  nativeCaptureActive?: boolean;
  nativeCaptureError?: string | null;
  sttState?: ConnectionState;
  startedAtMs?: number | null;
  nowMs?: number;
  sttError?: string | null;
}) {
  const startedAtMs = input.startedAtMs ?? null;
  return evaluateAudioPreflight({
    nativeModule: input.nativeModule ?? validNativeModule,
    nativeCaptureActive: input.nativeCaptureActive ?? startedAtMs !== null,
    nativeCaptureError: input.nativeCaptureError ?? null,
    permissions: input.permissions ?? grantedPermissions,
    stats: input.audioStats ?? stats(),
    sttState: input.sttState ?? 'disconnected',
    startedAtMs,
    nowMs: input.nowMs ?? 10_000,
    sttError: input.sttError ?? null,
  });
}

describe('audio preflight', () => {
  it('blocks missing permissions before audio starts', () => {
    const result = report({ permissions: { screen: false, microphone: true } });

    expect(result.overall).toBe('blocked');
    expect(result.checks.find((check) => check.id === 'permissions')).toMatchObject({
      status: 'blocked',
    });
  });

  it('blocks missing or contract-invalid native modules', () => {
    const missing = report({
      nativeModule: { available: false, contractValid: false, modulePath: '/tmp/missing.node' },
    });
    const invalid = report({
      nativeModule: {
        available: true,
        contractValid: false,
        modulePath: '/tmp/audio_capture.node',
      },
    });

    expect(missing.overall).toBe('blocked');
    expect(invalid.overall).toBe('blocked');
    expect(missing.checks.find((check) => check.id === 'native_module')).toMatchObject({
      status: 'blocked',
    });
    expect(invalid.checks.find((check) => check.id === 'native_module')).toMatchObject({
      status: 'blocked',
    });
  });

  it('keeps native capture pending during the startup grace window', () => {
    const result = report({
      nativeCaptureActive: false,
      startedAtMs: 1_000,
      nowMs: 1_100,
    });

    expect(result.overall).toBe('warning');
    expect(result.checks.find((check) => check.id === 'native_capture')).toMatchObject({
      status: 'pending',
      message: 'native capture の active 化を待っています。',
    });
  });

  it('blocks when native capture stays inactive after the startup grace window', () => {
    const result = report({
      nativeCaptureActive: false,
      startedAtMs: 1_000,
      nowMs: 6_000,
    });

    expect(result.overall).toBe('blocked');
    expect(result.checks.find((check) => check.id === 'native_capture')).toMatchObject({
      status: 'blocked',
    });
  });

  it('blocks native capture runtime errors with the concrete message', () => {
    const result = report({
      nativeCaptureActive: true,
      nativeCaptureError: 'screen_capture_stream_stopped: Zoom audio stream stopped',
      startedAtMs: 1_000,
      nowMs: 2_000,
    });

    expect(result.overall).toBe('blocked');
    expect(result.checks.find((check) => check.id === 'native_capture')).toMatchObject({
      status: 'blocked',
      message:
        'native capture が停止または失敗しました: screen_capture_stream_stopped: Zoom audio stream stopped',
    });
  });

  it('keeps source checks pending before diagnosis starts even when old chunks exist', () => {
    const result = report({
      audioStats: stats({
        selfChunks: 1,
        counterpartChunks: 1,
        selfLastReceivedAtMs: 1_000,
        counterpartLastReceivedAtMs: 1_000,
      }),
      sttState: 'connected',
      startedAtMs: null,
      nowMs: 10_000,
    });

    expect(result.overall).toBe('warning');
    expect(result.checks.find((check) => check.id === 'self_audio')).toMatchObject({
      status: 'pending',
    });
    expect(result.checks.find((check) => check.id === 'counterpart_audio')).toMatchObject({
      status: 'pending',
    });
  });

  it('does not block self audio during the first five seconds', () => {
    const result = report({
      sttState: 'connecting',
      startedAtMs: 1_000,
      nowMs: 5_900,
    });

    expect(result.overall).toBe('warning');
    expect(result.checks.find((check) => check.id === 'self_audio')).toMatchObject({
      status: 'pending',
    });
  });

  it('blocks when self chunks are still zero after five seconds', () => {
    const result = report({
      sttState: 'connected',
      startedAtMs: 1_000,
      nowMs: 6_000,
    });

    expect(result.overall).toBe('blocked');
    expect(result.checks.find((check) => check.id === 'self_audio')).toMatchObject({
      status: 'blocked',
    });
  });

  it('warns when counterpart chunks are still zero after five seconds', () => {
    const result = report({
      audioStats: stats({ selfChunks: 1, selfLastReceivedAtMs: 5_900 }),
      sttState: 'connected',
      startedAtMs: 1_000,
      nowMs: 6_000,
    });

    expect(result.overall).toBe('warning');
    expect(result.checks.find((check) => check.id === 'counterpart_audio')).toMatchObject({
      status: 'warning',
    });
  });

  it('warns while STT is reconnecting and blocks failed STT', () => {
    const reconnecting = report({
      audioStats: stats({
        selfChunks: 1,
        counterpartChunks: 1,
        selfLastReceivedAtMs: 5_900,
        counterpartLastReceivedAtMs: 5_900,
      }),
      sttState: 'reconnecting',
      startedAtMs: 1_000,
      nowMs: 6_000,
    });
    const failed = report({
      audioStats: stats({
        selfChunks: 1,
        counterpartChunks: 1,
        selfLastReceivedAtMs: 5_900,
        counterpartLastReceivedAtMs: 5_900,
      }),
      sttState: 'failed',
      startedAtMs: 1_000,
      nowMs: 6_000,
    });

    expect(reconnecting.overall).toBe('warning');
    expect(reconnecting.checks.find((check) => check.id === 'stt_connection')).toMatchObject({
      status: 'warning',
    });
    expect(failed.overall).toBe('blocked');
    expect(failed.checks.find((check) => check.id === 'stt_connection')).toMatchObject({
      status: 'blocked',
    });
  });

  it('warns when only self audio is stale even if counterpart keeps flowing', () => {
    const result = report({
      audioStats: stats({
        selfChunks: 1,
        counterpartChunks: 5,
        selfLastReceivedAtMs: 2_000,
        counterpartLastReceivedAtMs: 5_900,
      }),
      sttState: 'connected',
      startedAtMs: 1_000,
      nowMs: 6_000,
    });

    expect(result.overall).toBe('warning');
    expect(result.checks.find((check) => check.id === 'self_audio')).toMatchObject({
      status: 'warning',
    });
    expect(result.checks.find((check) => check.id === 'counterpart_audio')).toMatchObject({
      status: 'pass',
    });
    expect(result.checks.find((check) => check.id === 'audio_freshness')).toMatchObject({
      status: 'pass',
    });
  });

  it('warns when only counterpart audio is stale even if self keeps flowing', () => {
    const result = report({
      audioStats: stats({
        selfChunks: 5,
        counterpartChunks: 1,
        selfLastReceivedAtMs: 5_900,
        counterpartLastReceivedAtMs: 2_000,
      }),
      sttState: 'connected',
      startedAtMs: 1_000,
      nowMs: 6_000,
    });

    expect(result.overall).toBe('warning');
    expect(result.checks.find((check) => check.id === 'self_audio')).toMatchObject({
      status: 'pass',
    });
    expect(result.checks.find((check) => check.id === 'counterpart_audio')).toMatchObject({
      status: 'warning',
    });
    expect(result.checks.find((check) => check.id === 'audio_freshness')).toMatchObject({
      status: 'pass',
    });
  });

  it('warns when the last audio chunk is stale', () => {
    const result = report({
      audioStats: stats({
        selfChunks: 1,
        counterpartChunks: 1,
        selfLastReceivedAtMs: 2_000,
        counterpartLastReceivedAtMs: 2_000,
      }),
      sttState: 'connected',
      startedAtMs: 1_000,
      nowMs: 5_500,
    });

    expect(result.overall).toBe('warning');
    expect(result.checks.find((check) => check.id === 'audio_freshness')).toMatchObject({
      status: 'warning',
    });
  });

  it('returns go when both sources and STT are healthy', () => {
    const result = report({
      audioStats: stats({
        selfChunks: 2,
        counterpartChunks: 2,
        selfLastReceivedAtMs: 5_900,
        counterpartLastReceivedAtMs: 5_900,
      }),
      sttState: 'connected',
      startedAtMs: 1_000,
      nowMs: 6_000,
    });

    expect(result.overall).toBe('go');
    expect(result.checks.map((check) => check.id)).toEqual([
      'permissions',
      'native_module',
      'native_capture',
      'stt_connection',
      'self_audio',
      'counterpart_audio',
      'audio_freshness',
    ]);
  });
});
