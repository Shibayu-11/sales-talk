import { shell, systemPreferences } from 'electron';
import type { PermissionState } from '@shared/types';

type MediaAccessType = Parameters<typeof systemPreferences.getMediaAccessStatus>[0];
type AudioCapturePermission = keyof PermissionState;

function isGranted(mediaType: MediaAccessType): boolean {
  return systemPreferences.getMediaAccessStatus(mediaType) === 'granted';
}

export function checkPermissions(): PermissionState {
  if (process.platform !== 'darwin') {
    return { screen: true, microphone: true };
  }

  return {
    screen: isGranted('screen' as MediaAccessType),
    microphone: isGranted('microphone'),
  };
}

export async function requestMicrophonePermission(): Promise<PermissionState> {
  if (process.platform === 'darwin') {
    await systemPreferences.askForMediaAccess('microphone');
  }
  return checkPermissions();
}

export async function requestScreenPermission(): Promise<PermissionState> {
  if (process.platform === 'darwin') {
    await shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    );
  }
  return checkPermissions();
}

export function getMissingAudioCapturePermissions(
  permissions: PermissionState,
): AudioCapturePermission[] {
  const missing: AudioCapturePermission[] = [];
  if (!permissions.microphone) {
    missing.push('microphone');
  }
  if (!permissions.screen) {
    missing.push('screen');
  }
  return missing;
}

export function formatMissingAudioCapturePermissions(
  permissions: PermissionState,
): string | null {
  const missing = getMissingAudioCapturePermissions(permissions);
  if (missing.length === 0) {
    return null;
  }

  const labels: Record<AudioCapturePermission, string> = {
    microphone: 'Microphone',
    screen: 'Screen Recording',
  };
  return `音声キャプチャ開始には ${missing.map((permission) => labels[permission]).join(' / ')} 権限が必要です。`;
}
