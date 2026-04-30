import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { NativeAudioCaptureModule } from './native-audio-capture';

const requireNative = createRequire(import.meta.url);

export interface NativeAudioCaptureModuleStatus {
  available: boolean;
  contractValid: boolean;
  modulePath: string;
  error?: string | undefined;
}

export function resolveNativeAudioCaptureModulePath(): string {
  return (
    process.env.SALES_TALK_AUDIO_CAPTURE_MODULE ??
    join(process.cwd(), 'src/native/audio-capture/build/Release/audio_capture.node')
  );
}

export function loadNativeAudioCaptureModule(
  modulePath = resolveNativeAudioCaptureModulePath(),
): NativeAudioCaptureModule | null {

  if (!existsSync(modulePath)) {
    return null;
  }

  const loadedModule = requireNative(modulePath) as Partial<NativeAudioCaptureModule>;
  if (
    typeof loadedModule.startCapture !== 'function' ||
    typeof loadedModule.stopCapture !== 'function' ||
    typeof loadedModule.onAudioChunk !== 'function' ||
    typeof loadedModule.onError !== 'function'
  ) {
    throw new Error('Native audio capture module does not match the expected contract');
  }

  return loadedModule as NativeAudioCaptureModule;
}

export function getNativeAudioCaptureModuleStatus(
  modulePath = resolveNativeAudioCaptureModulePath(),
): NativeAudioCaptureModuleStatus {
  if (!existsSync(modulePath)) {
    return { available: false, contractValid: false, modulePath };
  }

  try {
    loadNativeAudioCaptureModule(modulePath);
    return { available: true, contractValid: true, modulePath };
  } catch (error) {
    return {
      available: true,
      contractValid: false,
      modulePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
