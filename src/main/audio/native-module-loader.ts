import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { NativeAudioCaptureModule } from './native-audio-capture';

const requireNative = createRequire(import.meta.url);
const AUDIO_CAPTURE_RESOURCE_PATH = join('native', 'audio-capture', 'audio_capture.node');
const AUDIO_CAPTURE_DEV_PATH = join(
  'src',
  'native',
  'audio-capture',
  'build',
  'Release',
  'audio_capture.node',
);

type ProcessWithElectronResources = NodeJS.Process & { resourcesPath?: string };

export interface NativeAudioCaptureModuleStatus {
  available: boolean;
  contractValid: boolean;
  modulePath: string;
  error?: string | undefined;
}

function getElectronResourcesPath(): string | null {
  const resourcesPath = (process as ProcessWithElectronResources).resourcesPath;
  return typeof resourcesPath === 'string' && resourcesPath.length > 0 ? resourcesPath : null;
}

export function getNativeAudioCaptureModuleCandidatePaths(): string[] {
  if (process.env.SALES_TALK_AUDIO_CAPTURE_MODULE) {
    return [process.env.SALES_TALK_AUDIO_CAPTURE_MODULE];
  }

  const resourcesPath = getElectronResourcesPath();
  const candidatePaths = resourcesPath ? [join(resourcesPath, AUDIO_CAPTURE_RESOURCE_PATH)] : [];
  candidatePaths.push(join(process.cwd(), AUDIO_CAPTURE_DEV_PATH));
  return candidatePaths;
}

export function resolveNativeAudioCaptureModulePath(): string {
  const candidatePaths = getNativeAudioCaptureModuleCandidatePaths();
  return (
    candidatePaths.find((candidatePath) => existsSync(candidatePath)) ??
    candidatePaths[0] ??
    join(process.cwd(), AUDIO_CAPTURE_DEV_PATH)
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
