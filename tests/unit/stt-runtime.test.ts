import type { BrowserWindow } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { IPC } from '../../src/shared/ipc-channels';
import type { AudioChunk, Transcript } from '../../src/shared/types';
import { createRuntimeSTTClient } from '../../src/main/services/stt-runtime';
import type { STTProvider } from '../../src/main/services/stt';

class FakeProvider implements STTProvider {
  private transcriptHandler: ((transcript: Transcript) => void) | null = null;
  connect = vi.fn(async () => {});
  disconnect = vi.fn(async () => {});
  sendAudio = vi.fn(async (_chunk: AudioChunk) => {});

  setTranscriptHandler(handler: (transcript: Transcript) => void): void {
    this.transcriptHandler = handler;
  }

  emit(transcript: Transcript): void {
    this.transcriptHandler?.(transcript);
  }
}

function finalTranscript(text = '価格が高いですね'): Transcript {
  return {
    speaker: 'counterpart',
    text,
    isFinal: true,
    startMs: 0,
    endMs: 1_000,
  };
}

function fakeWindow(send: ReturnType<typeof vi.fn>): BrowserWindow {
  return { webContents: { send } } as unknown as BrowserWindow;
}

describe('createRuntimeSTTClient', () => {
  it('publishes transcripts and routes them to the pipeline only during calls', async () => {
    const provider = new FakeProvider();
    const send = vi.fn();
    const onPipelineTranscript = vi.fn(async () => {});
    let inCall = false;
    createRuntimeSTTClient({
      provider,
      windows: {
        getControlWindow: () => fakeWindow(send),
        getOverlayWindow: () => null,
      },
      isInCall: () => inCall,
      onPipelineTranscript,
    });

    provider.emit(finalTranscript('商談前の発話'));
    await Promise.resolve();

    expect(send).toHaveBeenCalledWith(
      IPC.stt.onFinal,
      expect.objectContaining({ text: '商談前の発話' }),
    );
    expect(onPipelineTranscript).not.toHaveBeenCalled();

    inCall = true;
    provider.emit(finalTranscript('価格が高いですね'));
    await Promise.resolve();

    expect(onPipelineTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ text: '価格が高いですね', isFinal: true }),
    );
  });

  it('publishes connection state and errors to control window', async () => {
    const provider = new FakeProvider();
    const send = vi.fn();
    const client = createRuntimeSTTClient({
      provider,
      windows: {
        getControlWindow: () => fakeWindow(send),
        getOverlayWindow: () => null,
      },
      isInCall: () => false,
      onPipelineTranscript: vi.fn(async () => {}),
    });

    await client.start();

    expect(send).toHaveBeenCalledWith(IPC.stt.onConnectionState, 'connecting');
    expect(send).toHaveBeenCalledWith(IPC.stt.onConnectionState, 'connected');
  });
});
