import { describe, expect, it, vi } from 'vitest';
import type { AudioChunk } from '../../src/shared/types';
import { ResilientSTTClient, type STTProvider } from '../../src/main/services/stt';

const chunk: AudioChunk = {
  speaker: 'counterpart',
  data: 'base64-audio',
  startMs: 0,
  durationMs: 100,
};

class FakeProvider implements STTProvider {
  connect = vi.fn(async () => {});
  disconnect = vi.fn(async () => {});
  sendAudio = vi.fn(async () => {});
  transcriptHandler: ((transcript: import('../../src/shared/types').Transcript) => void) | null = null;
  setTranscriptHandler(handler: (transcript: import('../../src/shared/types').Transcript) => void): void {
    this.transcriptHandler = handler;
  }
}

describe('ResilientSTTClient', () => {
  it('buffers audio while disconnected and flushes after start', async () => {
    const provider = new FakeProvider();
    const client = new ResilientSTTClient(provider, { reconnectDelayMs: () => 0 });

    await client.sendAudio(chunk);
    expect(client.getBufferedDurationMs()).toBe(100);

    await client.start();

    expect(client.getState()).toBe('connected');
    expect(provider.sendAudio).toHaveBeenCalledWith(chunk);
    expect(client.getBufferedDurationMs()).toBe(0);
  });

  it('reconnects and preserves the failed send chunk', async () => {
    const provider = new FakeProvider();
    provider.sendAudio
      .mockRejectedValueOnce(new Error('socket closed'))
      .mockResolvedValueOnce(undefined);
    const states: string[] = [];
    const client = new ResilientSTTClient(provider, {
      reconnectDelayMs: () => 0,
      onStateChange: (state) => states.push(state),
    });

    await client.start();
    await client.sendAudio(chunk);

    expect(provider.connect).toHaveBeenCalledTimes(2);
    expect(provider.sendAudio).toHaveBeenCalledTimes(2);
    expect(states).toContain('reconnecting');
    expect(client.getState()).toBe('connected');
  });

  it('drops oldest buffered audio beyond max duration', async () => {
    const provider = new FakeProvider();
    const client = new ResilientSTTClient(provider, { bufferMaxMs: 150 });

    await client.sendAudio({ ...chunk, startMs: 0 });
    await client.sendAudio({ ...chunk, startMs: 100 });

    expect(client.getBufferedDurationMs()).toBe(100);
  });

  it('forwards provider transcripts to the configured callback', () => {
    const provider = new FakeProvider();
    const onTranscript = vi.fn();
    new ResilientSTTClient(provider, { onTranscript });

    provider.transcriptHandler?.({
      speaker: 'counterpart',
      text: '価格が高いですね',
      isFinal: true,
      startMs: 0,
      endMs: 1_000,
    });

    expect(onTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ text: '価格が高いですね', isFinal: true }),
    );
  });
});
