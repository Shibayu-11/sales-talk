import { describe, expect, it, vi } from 'vitest';
import {
  NativeAudioCaptureService,
  nativeChunkToAudioChunk,
  type NativeAudioCaptureModule,
  type NativeAudioChunk,
} from '../../src/main/audio/native-audio-capture';

class FakeNativeAudioCaptureModule implements NativeAudioCaptureModule {
  audioCallback: ((chunk: NativeAudioChunk) => void) | null = null;
  errorCallback: ((error: { code: string; message: string }) => void) | null = null;
  startCapture = vi.fn(async () => ({ sessionId: 'session-1' }));
  stopCapture = vi.fn(async () => {});

  onAudioChunk(cb: (chunk: NativeAudioChunk) => void): void {
    this.audioCallback = cb;
  }

  onError(cb: (error: { code: string; message: string }) => void): void {
    this.errorCallback = cb;
  }
}

describe('nativeChunkToAudioChunk', () => {
  it('maps system chunks to counterpart audio chunks', () => {
    expect(
      nativeChunkToAudioChunk({
        source: 'system',
        data: Buffer.from([1, 2, 3]),
        timestamp: 123.4,
        durationMs: 120,
        sampleRate: 16_000,
      }),
    ).toEqual({
      speaker: 'counterpart',
      data: 'AQID',
      startMs: 123,
      durationMs: 120,
    });
  });

  it('maps microphone chunks to self audio chunks', () => {
    expect(
      nativeChunkToAudioChunk({
        source: 'microphone',
        data: 'base64-audio',
        timestamp: 10,
        sampleRate: 16_000,
      }),
    ).toEqual({
      speaker: 'self',
      data: 'base64-audio',
      startMs: 10,
      durationMs: 100,
    });
  });
});

describe('NativeAudioCaptureService', () => {
  it('starts native capture and forwards chunks to STT sender', async () => {
    const module = new FakeNativeAudioCaptureModule();
    const sendAudioChunk = vi.fn(async () => {});
    const service = new NativeAudioCaptureService({ module, sendAudioChunk });

    await service.start();
    module.audioCallback?.({
      source: 'system',
      data: new Uint8Array([4, 5, 6]),
      timestamp: 500,
      durationMs: 100,
      sampleRate: 16_000,
    });

    expect(module.startCapture).toHaveBeenCalledWith({
      targetAppBundleId: 'us.zoom.xos',
      sampleRate: 16_000,
    });
    expect(sendAudioChunk).toHaveBeenCalledWith({
      speaker: 'counterpart',
      data: 'BAUG',
      startMs: 500,
      durationMs: 100,
    });
  });

  it('stops the active native capture session', async () => {
    const module = new FakeNativeAudioCaptureModule();
    const service = new NativeAudioCaptureService({
      module,
      sendAudioChunk: vi.fn(async () => {}),
    });

    await service.start();
    await service.stop();

    expect(module.stopCapture).toHaveBeenCalledWith('session-1');
  });
});
