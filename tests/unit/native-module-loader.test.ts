import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  getNativeAudioCaptureModuleStatus,
  loadNativeAudioCaptureModule,
} from '../../src/main/audio/native-module-loader';

async function writeTempModule(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sales-talk-native-'));
  const modulePath = join(directory, 'audio_capture.cjs');
  await writeFile(modulePath, source, 'utf8');
  return modulePath;
}

describe('native audio module loader', () => {
  it('reports missing modules without throwing', () => {
    const modulePath = join(tmpdir(), 'missing-audio-capture.node');

    expect(loadNativeAudioCaptureModule(modulePath)).toBeNull();
    expect(getNativeAudioCaptureModuleStatus(modulePath)).toEqual({
      available: false,
      contractValid: false,
      modulePath,
    });
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
