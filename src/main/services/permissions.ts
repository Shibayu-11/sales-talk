import { shell, systemPreferences } from 'electron';
import type { PermissionState } from '@shared/types';

type MediaAccessType = Parameters<typeof systemPreferences.getMediaAccessStatus>[0];

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
