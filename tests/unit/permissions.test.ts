import { describe, expect, it, vi } from 'vitest';
import type { PermissionState } from '../../src/shared/types';

vi.mock('electron', () => ({
  shell: {
    openExternal: vi.fn(),
  },
  systemPreferences: {
    askForMediaAccess: vi.fn(),
    getMediaAccessStatus: vi.fn(() => 'granted'),
  },
}));

import {
  formatMissingAudioCapturePermissions,
  getMissingAudioCapturePermissions,
} from '../../src/main/services/permissions';

describe('permissions service', () => {
  it('reports no missing audio capture permissions when all are granted', () => {
    const permissions: PermissionState = { microphone: true, screen: true };

    expect(getMissingAudioCapturePermissions(permissions)).toEqual([]);
    expect(formatMissingAudioCapturePermissions(permissions)).toBeNull();
  });

  it('formats missing audio capture permissions in deterministic order', () => {
    const permissions: PermissionState = { microphone: false, screen: false };

    expect(getMissingAudioCapturePermissions(permissions)).toEqual(['microphone', 'screen']);
    expect(formatMissingAudioCapturePermissions(permissions)).toBe(
      '音声キャプチャ開始には Microphone / Screen Recording 権限が必要です。',
    );
  });
});
