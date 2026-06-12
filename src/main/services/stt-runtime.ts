import { IPC } from '@shared/ipc-channels';
import type { BrowserWindow } from 'electron';
import type { SttProviderKind, SttProviderMode, Transcript } from '@shared/types';
import { logger } from '../logger';
import { ResilientSTTClient, type STTProvider } from './stt';
import { createDeepgramSTTProvider } from './deepgram';
import { resolveSTTProvider } from './stt-provider-resolver';

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

export interface RuntimeConfiguredSTTClientOptions extends Omit<RuntimeSTTClientOptions, 'provider'> {
  mode: SttProviderMode;
  resolveProvider?: typeof resolveSTTProvider | undefined;
}

export interface RuntimeConfiguredSTTClient {
  client: ResilientSTTClient;
  providerKind: SttProviderKind;
  degradedReason: string | null;
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

export async function createRuntimeFallbackSTTClient(
  options: Omit<RuntimeSTTClientOptions, 'provider'>,
): Promise<ResilientSTTClient> {
  return createRuntimeDeepgramSTTClient(options);
}

export async function createRuntimeConfiguredSTTClient(
  options: RuntimeConfiguredSTTClientOptions,
): Promise<RuntimeConfiguredSTTClient> {
  const resolve = options.resolveProvider ?? resolveSTTProvider;
  const resolved = await resolve({
    mode: options.mode,
    speaker: 'counterpart',
  });

  logger.info(
    {
      requestedMode: options.mode,
      providerKind: resolved.kind,
      degradedReason: resolved.degradedReason,
    },
    'resolved stt provider',
  );

  return {
    client: createRuntimeSTTClient({
      ...options,
      provider: resolved.provider,
    }),
    providerKind: resolved.kind,
    degradedReason: resolved.degradedReason ?? null,
  };
}

function notifyTranscript(windows: RuntimeSTTWindowAccessors, transcript: Transcript): void {
  const channel = transcript.isFinal ? IPC.stt.onFinal : IPC.stt.onInterim;
  windows.getControlWindow()?.webContents.send(channel, transcript);
}
