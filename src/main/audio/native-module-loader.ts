import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { NativeAudioCaptureModule } from './native-audio-capture';

const requireNative = createRequire(import.meta.url);

export function loadNativeAudioCaptureModule(): NativeAudioCaptureModule | null {
  const modulePath =
    process.env.SALES_TALK_AUDIO_CAPTURE_MODULE ??
    join(process.cwd(), 'src/native/audio-capture/build/Release/audio_capture.node');

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
