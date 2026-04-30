import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getNativeAudioCaptureModuleCandidatePaths,
  getNativeAudioCaptureModuleStatus,
  loadNativeAudioCaptureModule,
  resolveNativeAudioCaptureModulePath,
} from '../../src/main/audio/native-module-loader';

async function writeTempModule(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sales-talk-native-'));
  const modulePath = join(directory, 'audio_capture.cjs');
  await writeFile(modulePath, source, 'utf8');
  return modulePath;
}

const originalResourcesPathDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath');

function setElectronResourcesPath(resourcesPath: string): void {
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    value: resourcesPath,
  });
}

function restoreElectronResourcesPath(): void {
  if (originalResourcesPathDescriptor) {
    Object.defineProperty(process, 'resourcesPath', originalResourcesPathDescriptor);
    return;
  }

  Reflect.deleteProperty(process, 'resourcesPath');
}

describe('native audio module loader', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    restoreElectronResourcesPath();
  });

  it('reports missing modules without throwing', () => {
    const modulePath = join(tmpdir(), 'missing-audio-capture.node');

    expect(loadNativeAudioCaptureModule(modulePath)).toBeNull();
    expect(getNativeAudioCaptureModuleStatus(modulePath)).toEqual({
      available: false,
      contractValid: false,
      modulePath,
    });
  });

  it('uses an explicit module override before packaged and dev paths', () => {
    const modulePath = join(tmpdir(), 'overridden-audio-capture.node');

    vi.stubEnv('SALES_TALK_AUDIO_CAPTURE_MODULE', modulePath);

    expect(getNativeAudioCaptureModuleCandidatePaths()).toEqual([modulePath]);
    expect(resolveNativeAudioCaptureModulePath()).toBe(modulePath);
  });

  it('prefers the packaged extraResources path when it exists', async () => {
    const resourcesPath = await mkdtemp(join(tmpdir(), 'sales-talk-resources-'));
    const nativeModuleDirectory = join(resourcesPath, 'native', 'audio-capture');
    const modulePath = join(nativeModuleDirectory, 'audio_capture.node');
    await mkdir(nativeModuleDirectory, { recursive: true });
    await writeFile(modulePath, '', 'utf8');
    setElectronResourcesPath(resourcesPath);

    expect(getNativeAudioCaptureModuleCandidatePaths()[0]).toBe(modulePath);
    expect(resolveNativeAudioCaptureModulePath()).toBe(modulePath);
  });

  it('validates the expected NAPI contract', async () => {
    const modulePath = await writeTempModule('module.exports = { startCapture() {} };');

    expect(() => loadNativeAudioCaptureModule(modulePath)).toThrow(
      'Native audio capture module does not match the expected contract',
    );
    expect(getNativeAudioCaptureModuleStatus(modulePath)).toEqual(
      expect.objectContaining({
        available: true,
        contractValid: false,
        modulePath,
      }),
    );
  });

  it('loads a module that matches the expected NAPI contract', async () => {
    const modulePath = await writeTempModule(`
      module.exports = {
        async startCapture() { return { sessionId: 'session-1' }; },
        async stopCapture() {},
        onAudioChunk() {},
        onError() {},
      };
    `);

    const loadedModule = loadNativeAudioCaptureModule(modulePath);

    expect(loadedModule).not.toBeNull();
    expect(getNativeAudioCaptureModuleStatus(modulePath)).toEqual({
      available: true,
      contractValid: true,
      modulePath,
    });
  });
});
