import { IPC } from '@shared/ipc-channels';
import type { BrowserWindow } from 'electron';
import type { Transcript } from '@shared/types';
import { logger } from '../logger';
import { ResilientSTTClient, type STTProvider } from './stt';
import { createDeepgramSTTProvider } from './deepgram';

export interface RuntimeSTTWindowAccessors {
  getControlWindow(): BrowserWindow | null;
  getOverlayWindow(): BrowserWindow | null;
}

export interface RuntimeSTTClientOptions {
  provider: STTProvider;
  windows: RuntimeSTTWindowAccessors;
  isInCall: () => boolean;
  onPipelineTranscript: (transcript: Transcript) => Promise<void>;
}

export function createRuntimeSTTClient(options: RuntimeSTTClientOptions): ResilientSTTClient {
  return new ResilientSTTClient(options.provider, {
    onStateChange: (state) => {
      options.windows.getControlWindow()?.webContents.send(IPC.stt.onConnectionState, state);
    },
    onTranscript: (transcript) => {
      notifyTranscript(options.windows, transcript);

      if (!options.isInCall()) {
        return;
      }

      void options.onPipelineTranscript(transcript).catch((error: unknown) => {
        logger.warn({ error }, 'failed to process stt transcript');
      });
    },
    onError: (error) => {
      logger.warn({ error }, 'stt client degraded');
      options.windows.getControlWindow()?.webContents.send(IPC.stt.onError, error.message);
    },
  });
}

export async function createRuntimeDeepgramSTTClient(
  options: Omit<RuntimeSTTClientOptions, 'provider'>,
): Promise<ResilientSTTClient> {
  return createRuntimeSTTClient({
    ...options,
    provider: await createDeepgramSTTProvider('counterpart'),
  });
}

function notifyTranscript(windows: RuntimeSTTWindowAccessors, transcript: Transcript): void {
  const channel = transcript.isFinal ? IPC.stt.onFinal : IPC.stt.onInterim;
  windows.getControlWindow()?.webContents.send(channel, transcript);
}
