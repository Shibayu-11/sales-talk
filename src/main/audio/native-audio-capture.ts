import type { AudioChunk, Speaker } from '@shared/types';

export type NativeAudioSource = 'system' | 'microphone';

export interface NativeAudioChunk {
  source: NativeAudioSource;
  data: Buffer | Uint8Array | string;
  timestamp: number;
  durationMs?: number | undefined;
  sampleRate: number;
}

export interface NativeCaptureError {
  code: string;
  message: string;
}

export interface NativeAudioCaptureModule {
  startCapture(config: {
    targetAppBundleId: string;
    sampleRate: number;
  }): Promise<{ sessionId: string }>;
  stopCapture(sessionId: string): Promise<void>;
  onAudioChunk(cb: (chunk: NativeAudioChunk) => void): void;
  onError(cb: (error: NativeCaptureError) => void): void;
}

export interface AudioCheckpointSink {
  write(chunk: AudioChunk): Promise<void>;
  drain(): Promise<void>;
}

export interface NativeAudioCaptureServiceOptions {
  module: NativeAudioCaptureModule;
  sendAudioChunk: (chunk: AudioChunk) => Promise<void>;
  checkpointSink?: AudioCheckpointSink | undefined;
  onCheckpointError?: ((error: Error) => void) | undefined;
  onError?: ((error: NativeCaptureError) => void) | undefined;
  targetAppBundleId?: string | undefined;
  sampleRate?: number | undefined;
  defaultDurationMs?: number | undefined;
}

export class NativeAudioCaptureService {
  private sessionId: string | null = null;
  private callbacksRegistered = false;
  private readonly targetAppBundleId: string;
  private readonly sampleRate: number;
  private readonly defaultDurationMs: number;

  constructor(private readonly options: NativeAudioCaptureServiceOptions) {
    this.targetAppBundleId = options.targetAppBundleId ?? 'us.zoom.xos';
    this.sampleRate = options.sampleRate ?? 16_000;
    this.defaultDurationMs = options.defaultDurationMs ?? 100;
  }

  async start(): Promise<void> {
    this.registerCallbacksOnce();
    if (this.sessionId) {
      return;
    }

    const session = await this.options.module.startCapture({
      targetAppBundleId: this.targetAppBundleId,
      sampleRate: this.sampleRate,
    });
    this.sessionId = session.sessionId;
  }

  async stop(): Promise<void> {
    const currentSessionId = this.sessionId;
    this.sessionId = null;
    let failure: Error | null = null;
    try {
      if (currentSessionId) {
        await this.options.module.stopCapture(currentSessionId);
      }
    } catch (error) {
      failure = normalizeError(error);
    }
    try {
      await this.options.checkpointSink?.drain();
    } catch (error) {
      failure ??= normalizeError(error);
    }
    if (failure) {
      throw failure;
    }
  }

  private registerCallbacksOnce(): void {
    if (this.callbacksRegistered) {
      return;
    }

    this.options.module.onAudioChunk((chunk) => {
      const audioChunk = nativeChunkToAudioChunk(chunk, this.defaultDurationMs);
      void this.options.checkpointSink?.write(audioChunk).catch((error: unknown) => {
        this.options.onCheckpointError?.(normalizeError(error));
      });
      void this.options.sendAudioChunk(audioChunk);
    });
    this.options.module.onError((error) => {
      this.options.onError?.(error);
    });
    this.callbacksRegistered = true;
  }
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Unknown checkpoint error');
}

export function nativeChunkToAudioChunk(
  chunk: NativeAudioChunk,
  defaultDurationMs = 100,
): AudioChunk {
  return {
    speaker: sourceToSpeaker(chunk.source),
    data: audioDataToBase64(chunk.data),
    startMs: Math.max(0, Math.round(chunk.timestamp)),
    durationMs: chunk.durationMs ?? defaultDurationMs,
  };
}

function sourceToSpeaker(source: NativeAudioSource): Speaker {
  return source === 'system' ? 'counterpart' : 'self';
}

function audioDataToBase64(data: Buffer | Uint8Array | string): string {
  if (typeof data === 'string') {
    return data;
  }
  return Buffer.from(data).toString('base64');
}
