import type {
  AudioCaptureStats,
  AudioPreflightCheck,
  AudioPreflightReport,
  ConnectionState,
  PermissionState,
} from '@shared/types';

const SELF_AUDIO_BLOCK_AFTER_MS = 5_000;
const NATIVE_CAPTURE_BLOCK_AFTER_MS = 5_000;
const COUNTERPART_AUDIO_WARN_AFTER_MS = 5_000;
const STALE_AUDIO_WARN_AFTER_MS = 3_000;

export interface AudioPreflightNativeModuleStatus {
  available: boolean;
  contractValid: boolean;
  modulePath: string;
  error?: string | undefined;
}

export interface AudioPreflightInput {
  nativeModule: AudioPreflightNativeModuleStatus;
  nativeCaptureActive: boolean;
  nativeCaptureError?: string | null | undefined;
  permissions: PermissionState;
  stats: AudioCaptureStats;
  sttState: ConnectionState;
  startedAtMs: number | null;
  nowMs?: number | undefined;
  sttError?: string | null | undefined;
}

export function evaluateAudioPreflight(input: AudioPreflightInput): AudioPreflightReport {
  const evaluatedAtMs = input.nowMs ?? Date.now();
  const elapsedMs =
    input.startedAtMs === null ? null : Math.max(0, evaluatedAtMs - input.startedAtMs);
  const checks = [
    evaluatePermissions(input.permissions),
    evaluateNativeModule(input.nativeModule),
    evaluateNativeCapture(
      input.nativeCaptureActive,
      input.startedAtMs,
      input.nativeCaptureError ?? null,
      elapsedMs,
    ),
    evaluateSttConnection(input.sttState, input.startedAtMs, input.sttError ?? null),
    evaluateSelfAudio(input.stats, input.startedAtMs, elapsedMs, evaluatedAtMs),
    evaluateCounterpartAudio(input.stats, input.startedAtMs, elapsedMs, evaluatedAtMs),
    evaluateAudioFreshness(input.stats, input.startedAtMs, evaluatedAtMs),
  ];

  return {
    overall: getOverall(checks),
    checks,
    startedAtMs: input.startedAtMs,
    evaluatedAtMs,
  };
}

function evaluatePermissions(permissions: PermissionState): AudioPreflightCheck {
  if (permissions.screen && permissions.microphone) {
    return {
      id: 'permissions',
      label: '権限',
      status: 'pass',
      message: 'Screen Recording と Microphone は許可済みです。',
      action: null,
    };
  }

  const missing = [
    !permissions.screen ? 'Screen Recording' : null,
    !permissions.microphone ? 'Microphone' : null,
  ].filter((name): name is string => name !== null);

  return {
    id: 'permissions',
    label: '権限',
    status: 'blocked',
    message: `${missing.join(' / ')} が未許可です。`,
    action: 'System Settings の Privacy & Security で不足している権限を許可してください。',
  };
}

function evaluateNativeModule(
  nativeModule: AudioPreflightNativeModuleStatus,
): AudioPreflightCheck {
  if (!nativeModule.available) {
    return {
      id: 'native_module',
      label: 'Native module',
      status: 'blocked',
      message: '音声取得用の native module が見つかりません。',
      action: '開発環境では npm run native:audio:build を実行し、module path を確認してください。',
    };
  }

  if (!nativeModule.contractValid) {
    return {
      id: 'native_module',
      label: 'Native module',
      status: 'blocked',
      message: 'native module の NAPI contract が期待値と一致していません。',
      action: 'audio_capture.node を現在の TypeScript 側 contract に合わせて再ビルドしてください。',
    };
  }

  return {
    id: 'native_module',
    label: 'Native module',
    status: 'pass',
    message: 'native module は利用できます。',
    action: null,
  };
}

function evaluateNativeCapture(
  nativeCaptureActive: boolean,
  startedAtMs: number | null,
  nativeCaptureError: string | null,
  elapsedMs: number | null,
): AudioPreflightCheck {
  if (nativeCaptureError) {
    return {
      id: 'native_capture',
      label: 'Native capture',
      status: 'blocked',
      message: `native capture が停止または失敗しました: ${nativeCaptureError}`,
      action: 'Zoom の起動状態と native module を確認し、診断を停止してから再実行してください。',
    };
  }

  if (startedAtMs === null) {
    return {
      id: 'native_capture',
      label: 'Native capture',
      status: 'pending',
      message: '診断開始後に native capture の起動を確認します。',
      action: null,
    };
  }

  if (!nativeCaptureActive) {
    if (elapsedMs !== null && elapsedMs < NATIVE_CAPTURE_BLOCK_AFTER_MS) {
      return {
        id: 'native_capture',
        label: 'Native capture',
        status: 'pending',
        message: 'native capture の active 化を待っています。',
        action: null,
      };
    }

    return {
      id: 'native_capture',
      label: 'Native capture',
      status: 'blocked',
      message: '診断開始後に native capture が active になっていません。',
      action: 'native module の起動失敗、Zoom 未起動、または Screen Recording 対象を確認してください。',
    };
  }

  return {
    id: 'native_capture',
    label: 'Native capture',
    status: 'pass',
    message: 'native capture は active です。',
    action: null,
  };
}

function evaluateSttConnection(
  sttState: ConnectionState,
  startedAtMs: number | null,
  sttError: string | null,
): AudioPreflightCheck {
  if (sttError) {
    return {
      id: 'stt_connection',
      label: 'STT接続',
      status: 'blocked',
      message: `STT の起動に失敗しました: ${sttError}`,
      action: 'Apple SpeechAnalyzer helper または fallback STT 設定を確認してください。',
    };
  }

  if (sttState === 'failed') {
    return {
      id: 'stt_connection',
      label: 'STT接続',
      status: 'blocked',
      message: 'STT 接続が failed です。',
      action: 'STT provider の設定と helper の起動状態を確認してから診断を再実行してください。',
    };
  }

  if (sttState === 'reconnecting') {
    return {
      id: 'stt_connection',
      label: 'STT接続',
      status: 'warning',
      message: 'STT が reconnecting です。',
      action: '自動復旧を待ち、続く場合は fallback 設定またはネットワークを確認してください。',
    };
  }

  if (sttState === 'connected') {
    return {
      id: 'stt_connection',
      label: 'STT接続',
      status: 'pass',
      message: 'STT は connected です。',
      action: null,
    };
  }

  return {
    id: 'stt_connection',
    label: 'STT接続',
    status: 'pending',
    message:
      startedAtMs === null
        ? '診断開始後に STT 接続を確認します。'
        : 'STT 接続の確立を待っています。',
    action: startedAtMs === null ? '同意チェック後に診断開始を押してください。' : null,
  };
}

function evaluateSelfAudio(
  stats: AudioCaptureStats,
  startedAtMs: number | null,
  elapsedMs: number | null,
  evaluatedAtMs: number,
): AudioPreflightCheck {
  if (startedAtMs === null) {
    return pendingAudioCheck('self_audio', '自分側音声', '診断開始後に自分側音声を確認します。');
  }

  if (stats.self.chunks > 0) {
    if (isSourceStale(stats.self.lastReceivedAtMs, evaluatedAtMs)) {
      return {
        id: 'self_audio',
        label: '自分側音声',
        status: 'warning',
        message: '自分側音声の最後の chunk から3秒以上経過しています。',
        action: 'マイク入力が継続しているか、ミュートになっていないか確認してください。',
      };
    }

    return {
      id: 'self_audio',
      label: '自分側音声',
      status: 'pass',
      message: '自分側音声を受信しています。',
      action: null,
    };
  }

  if (elapsedMs !== null && elapsedMs >= SELF_AUDIO_BLOCK_AFTER_MS) {
    return {
      id: 'self_audio',
      label: '自分側音声',
      status: 'blocked',
      message: '診断開始から5秒以上、自分側音声 chunk が届いていません。',
      action: 'Microphone 権限、入力デバイス、ミュート状態を確認してください。',
    };
  }

  return pendingAudioCheck(
    'self_audio',
    '自分側音声',
    '自分側音声 chunk の初回受信を待っています。',
  );
}

function evaluateCounterpartAudio(
  stats: AudioCaptureStats,
  startedAtMs: number | null,
  elapsedMs: number | null,
  evaluatedAtMs: number,
): AudioPreflightCheck {
  if (startedAtMs === null) {
    return pendingAudioCheck('counterpart_audio', '相手側音声', '診断開始後に相手側音声を確認します。');
  }

  if (stats.counterpart.chunks > 0) {
    if (isSourceStale(stats.counterpart.lastReceivedAtMs, evaluatedAtMs)) {
      return {
        id: 'counterpart_audio',
        label: '相手側音声',
        status: 'warning',
        message: '相手側音声の最後の chunk から3秒以上経過しています。',
        action: 'Zoom の相手側音声が継続しているか、共有対象が変わっていないか確認してください。',
      };
    }

    return {
      id: 'counterpart_audio',
      label: '相手側音声',
      status: 'pass',
      message: '相手側音声を受信しています。',
      action: null,
    };
  }

  if (elapsedMs !== null && elapsedMs >= COUNTERPART_AUDIO_WARN_AFTER_MS) {
    return {
      id: 'counterpart_audio',
      label: '相手側音声',
      status: 'warning',
      message: '相手側音声 chunk がまだ届いていません。',
      action: 'Zoom の相手側音声が出ているか、Screen Recording 対象が正しいか確認してください。',
    };
  }

  return pendingAudioCheck(
    'counterpart_audio',
    '相手側音声',
    '開始直後のため、相手側音声 chunk の初回受信を待っています。',
  );
}

function evaluateAudioFreshness(
  stats: AudioCaptureStats,
  startedAtMs: number | null,
  evaluatedAtMs: number,
): AudioPreflightCheck {
  if (startedAtMs === null) {
    return pendingAudioCheck(
      'audio_freshness',
      '音声鮮度',
      '診断開始後に最後の chunk 時刻を確認します。',
    );
  }

  if (stats.total.lastReceivedAtMs === null) {
    return pendingAudioCheck('audio_freshness', '音声鮮度', '音声 chunk の初回受信を待っています。');
  }

  const staleMs = evaluatedAtMs - stats.total.lastReceivedAtMs;
  if (staleMs > STALE_AUDIO_WARN_AFTER_MS) {
    return {
      id: 'audio_freshness',
      label: '音声鮮度',
      status: 'warning',
      message: '最後の音声 chunk から3秒以上経過しています。',
      action: 'Zoom 音声・マイク入力が継続しているか確認してください。',
    };
  }

  return {
    id: 'audio_freshness',
    label: '音声鮮度',
    status: 'pass',
    message: '直近の音声 chunk を受信しています。',
    action: null,
  };
}

function pendingAudioCheck(
  id: AudioPreflightCheck['id'],
  label: string,
  message: string,
): AudioPreflightCheck {
  return {
    id,
    label,
    status: 'pending',
    message,
    action: null,
  };
}

function getOverall(checks: AudioPreflightCheck[]): AudioPreflightReport['overall'] {
  if (checks.some((check) => check.status === 'blocked')) {
    return 'blocked';
  }

  if (checks.every((check) => check.status === 'pass')) {
    return 'go';
  }

  return 'warning';
}

function isSourceStale(lastReceivedAtMs: number | null, evaluatedAtMs: number): boolean {
  return lastReceivedAtMs !== null && evaluatedAtMs - lastReceivedAtMs > STALE_AUDIO_WARN_AFTER_MS;
}
