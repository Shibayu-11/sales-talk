import { STT_BUFFER_MAX_MS, STT_MAX_RECONNECT } from '@shared/constants';
import type { AudioChunk, ConnectionState, Transcript } from '@shared/types';

export interface STTProvider {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendAudio(chunk: AudioChunk): Promise<void>;
}

export interface ResilientSTTClientOptions {
  maxReconnectAttempts?: number;
  bufferMaxMs?: number;
  reconnectDelayMs?: (attempt: number) => number;
  onStateChange?: (state: ConnectionState) => void;
  onTranscript?: (transcript: Transcript) => void;
  onError?: (error: Error) => void;
}

export class ResilientSTTClient {
  private state: ConnectionState = 'disconnected';
  private reconnectAttempts = 0;
  private readonly bufferedChunks: AudioChunk[] = [];

  constructor(
    private readonly provider: STTProvider,
    private readonly options: ResilientSTTClientOptions = {},
  ) {}

  getState(): ConnectionState {
    return this.state;
  }

  getBufferedDurationMs(): number {
    return this.bufferedChunks.reduce((total, chunk) => total + chunk.durationMs, 0);
  }

  async start(): Promise<void> {
    this.setState('connecting');
    try {
      await this.provider.connect();
      this.reconnectAttempts = 0;
      this.setState('connected');
      await this.flushBufferedChunks();
    } catch (error) {
      await this.reconnect(toError(error));
    }
  }

  async stop(): Promise<void> {
    this.bufferedChunks.length = 0;
    this.reconnectAttempts = 0;
    await this.provider.disconnect();
    this.setState('disconnected');
  }

  async sendAudio(chunk: AudioChunk): Promise<void> {
    if (this.state !== 'connected') {
      this.bufferChunk(chunk);
      return;
    }

    try {
      await this.provider.sendAudio(chunk);
    } catch (error) {
      this.bufferChunk(chunk);
      await this.reconnect(toError(error));
    }
  }

  private async reconnect(cause: Error): Promise<void> {
    const maxAttempts = this.options.maxReconnectAttempts ?? STT_MAX_RECONNECT;
    if (this.reconnectAttempts >= maxAttempts) {
      this.setState('failed');
      this.options.onError?.(cause);
      return;
    }

    this.reconnectAttempts += 1;
    this.setState('reconnecting');
    const delay = this.options.reconnectDelayMs?.(this.reconnectAttempts) ?? defaultDelayMs(this.reconnectAttempts);
    await sleep(delay);
    await this.start();
  }

  private bufferChunk(chunk: AudioChunk): void {
    this.bufferedChunks.push(chunk);
    const bufferMaxMs = this.options.bufferMaxMs ?? STT_BUFFER_MAX_MS;
    while (this.getBufferedDurationMs() > bufferMaxMs) {
      this.bufferedChunks.shift();
    }
  }

  private async flushBufferedChunks(): Promise<void> {
    while (this.bufferedChunks.length > 0 && this.state === 'connected') {
      const chunk = this.bufferedChunks.shift();
      if (!chunk) return;
      await this.provider.sendAudio(chunk);
    }
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onStateChange?.(state);
  }
}

function defaultDelayMs(attempt: number): number {
  return Math.min(30_000, 500 * 2 ** Math.max(0, attempt - 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
