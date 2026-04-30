import { app, BrowserWindow, ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import {
  AppSettingsPatchSchema,
  AudioChunkSchema,
  FeedbackSchema,
  KnowledgeSearchInputSchema,
  ObjectionDismissInputSchema,
  OverlayLayerSchema,
  ProductIdSchema,
  SecretKeySchema,
  SecretSetInputSchema,
} from '@shared/schemas';
import type {
  AppSettings,
  AudioChunk,
  CallState,
  PermissionState,
  SharingState,
  Transcript,
} from '@shared/types';
import { logger } from '../logger';
import {
  checkPermissions,
  requestMicrophonePermission,
  requestScreenPermission,
} from '../services/permissions';
import { secretStore } from '../services/secrets';
import { settingsStore } from '../services/settings';
import { setCallModeLogging } from '../logger';
import { createRuntimeKnowledgeSearchService } from '../services/knowledge-runtime';
import { createRuntimeObjectionPipelineService } from '../services/objection-runtime';
import type { ObjectionPipelineService } from '../services/objection-pipeline';
import { createRuntimeDeepgramSTTClient } from '../services/stt-runtime';
import type { ResilientSTTClient } from '../services/stt';
import { NativeAudioCaptureService } from '../audio/native-audio-capture';
import { loadNativeAudioCaptureModule } from '../audio/native-module-loader';

/**
 * Register all IPC handlers. Per PRD §23: Main concentrates all logic.
 */
interface IpcWindowAccessors {
  getControlWindow(): BrowserWindow | null;
  getOverlayWindow(): BrowserWindow | null;
}

let callState: CallState = { status: 'idle' };
const sharingState: SharingState = { status: 'not_sharing' };
const knowledgeSearchService = createRuntimeKnowledgeSearchService();
let activeObjectionPipelineService: ObjectionPipelineService | null = null;
let activeSttClient: ResilientSTTClient | null = null;
let activeNativeAudioCaptureService: NativeAudioCaptureService | null = null;

export function registerIpcHandlers(windows: IpcWindowAccessors): void {
  activeObjectionPipelineService = createRuntimeObjectionPipelineService(
    windows,
    () => (callState.status === 'in_call' ? callState.productId : null),
  );

  ipcMain.handle(IPC.app.version, () => app.getVersion());

  ipcMain.handle(IPC.permissions.check, () => checkPermissions());
  ipcMain.handle(IPC.permissions.requestScreen, async () => {
    const permissions = await requestScreenPermission();
    notifyPermissions(windows, permissions);
  });
  ipcMain.handle(IPC.permissions.requestMicrophone, async () => {
    const permissions = await requestMicrophonePermission();
    notifyPermissions(windows, permissions);
  });

  ipcMain.handle(IPC.settings.get, () => settingsStore.get());
  ipcMain.handle(IPC.settings.set, async (_event, payload: unknown) => {
    const patch = AppSettingsPatchSchema.parse(payload);
    const settings = await settingsStore.set(patch);
    notifySettings(windows, settings);
  });

  ipcMain.handle(IPC.secrets.set, async (_event, payload: unknown) => {
    const input = SecretSetInputSchema.parse(payload);
    await secretStore.set(input.key, input.value);
  });
  ipcMain.handle(IPC.secrets.has, (_event, payload: unknown) => {
    const key = SecretKeySchema.parse(payload);
    return secretStore.has(key);
  });
  ipcMain.handle(IPC.secrets.delete, async (_event, payload: unknown) => {
    const key = SecretKeySchema.parse(payload);
    await secretStore.delete(key);
  });

  ipcMain.handle(IPC.audio.start, async () => {
    await startSTT(windows);
    await tryStartNativeAudioCapture(windows);
  });

  ipcMain.handle(IPC.audio.stop, async () => {
    await stopNativeAudioCapture();
    await stopSTT();
  });

  ipcMain.handle(IPC.audio.onSystemChunk, async (_event, payload: unknown) => {
    const chunk = AudioChunkSchema.parse(payload);
    await sendAudioChunkToSTT({ ...chunk, speaker: 'counterpart' });
  });

  ipcMain.handle(IPC.audio.onMicrophoneChunk, async (_event, payload: unknown) => {
    const chunk = AudioChunkSchema.parse(payload);
    await sendAudioChunkToSTT({ ...chunk, speaker: 'self' });
  });

  ipcMain.handle(IPC.call.start, async (_event, payload: unknown) => {
    const productId = ProductIdSchema.parse(payload);
    callState = { status: 'in_call', productId, startedAt: Date.now() };
    await tryStartSTT(windows);
    await tryStartNativeAudioCapture(windows);
    setCallModeLogging(true);
    notifyCallState(windows);
    windows.getOverlayWindow()?.showInactive();
    logger.info({ productId }, 'call started');
  });

  ipcMain.handle(IPC.call.end, () => {
    callState = { status: 'idle' };
    activeObjectionPipelineService?.cancelActive();
    void stopNativeAudioCapture();
    void stopSTT();
    setCallModeLogging(false);
    notifyCallState(windows);
    windows.getOverlayWindow()?.hide();
    logger.info('call ended');
  });

  ipcMain.handle(IPC.call.setProduct, async (_event, payload: unknown) => {
    const productId = ProductIdSchema.parse(payload);
    const settings = await settingsStore.set({ selectedProductId: productId });
    notifySettings(windows, settings);
    if (callState.status === 'in_call') {
      callState = { ...callState, productId };
      notifyCallState(windows);
    }
  });

  ipcMain.handle(IPC.overlay.show, () => windows.getOverlayWindow()?.showInactive());
  ipcMain.handle(IPC.overlay.hide, () => windows.getOverlayWindow()?.hide());
  ipcMain.handle(IPC.overlay.setHover, (_event, payload: unknown) => {
    const isHover = typeof payload === 'boolean' ? payload : false;
    windows.getOverlayWindow()?.setIgnoreMouseEvents(!isHover, { forward: true });
  });
  ipcMain.handle(IPC.overlay.setLayer, (_event, payload: unknown) => {
    const layer = OverlayLayerSchema.parse(payload);
    windows.getOverlayWindow()?.webContents.send(IPC.overlay.setLayer, layer);
  });

  ipcMain.handle(IPC.knowledge.search, (_event, payload: unknown) => {
    const input = KnowledgeSearchInputSchema.parse(payload);
    logger.debug({ productId: input.productId, limit: input.limit }, 'knowledge search requested');
    return knowledgeSearchService.search({
      query: input.query,
      productId: input.productId,
      limit: input.limit ?? 5,
    });
  });

  ipcMain.handle(IPC.objection.feedback, (_event, payload: unknown) => {
    const feedback = FeedbackSchema.parse(payload);
    logger.info({ objectionResponseId: feedback.objectionResponseId, used: feedback.used }, 'feedback');
  });

  ipcMain.handle(IPC.objection.dismiss, (_event, payload: unknown) => {
    const id = ObjectionDismissInputSchema.parse(payload);
    activeObjectionPipelineService?.cancelActive();
    logger.info({ id }, 'objection dismissed');
  });

  notifyCallState(windows);
  notifySharingState(windows);
  notifyPermissions(windows, checkPermissions());

  logger.debug('ipc handlers registered');
}

export async function handlePipelineTranscript(transcript: Transcript): Promise<void> {
  await activeObjectionPipelineService?.handleTranscript(transcript);
}

export async function sendAudioChunkToSTT(chunk: AudioChunk): Promise<void> {
  await activeSttClient?.sendAudio(chunk);
}

async function startSTT(windows: IpcWindowAccessors): Promise<void> {
  activeSttClient ??= await createRuntimeDeepgramSTTClient({
    windows,
    isInCall: () => callState.status === 'in_call',
    onPipelineTranscript: handlePipelineTranscript,
  });
  await activeSttClient.start();
}

async function tryStartSTT(windows: IpcWindowAccessors): Promise<void> {
  try {
    await startSTT(windows);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    windows.getControlWindow()?.webContents.send(IPC.stt.onError, message);
    logger.warn({ error }, 'stt start failed');
  }
}

async function stopSTT(): Promise<void> {
  await activeSttClient?.stop();
  activeSttClient = null;
}

async function tryStartNativeAudioCapture(windows: IpcWindowAccessors): Promise<void> {
  try {
    await startNativeAudioCapture();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    windows.getControlWindow()?.webContents.send(IPC.audio.onError, message);
    logger.warn({ error }, 'native audio capture start failed');
  }
}

async function startNativeAudioCapture(): Promise<void> {
  if (!activeNativeAudioCaptureService) {
    const nativeModule = loadNativeAudioCaptureModule();
    if (!nativeModule) {
      logger.warn('native audio capture module not found');
      return;
    }

    activeNativeAudioCaptureService = new NativeAudioCaptureService({
      module: nativeModule,
      sendAudioChunk: sendAudioChunkToSTT,
      onError: (error) => {
        logger.warn({ error }, 'native audio capture error');
      },
    });
  }

  await activeNativeAudioCaptureService.start();
}

async function stopNativeAudioCapture(): Promise<void> {
  await activeNativeAudioCaptureService?.stop();
  activeNativeAudioCaptureService = null;
}

function notifyCallState(windows: IpcWindowAccessors): void {
  windows.getControlWindow()?.webContents.send(IPC.call.onState, callState);
}

function notifyPermissions(windows: IpcWindowAccessors, permissions: PermissionState): void {
  windows.getControlWindow()?.webContents.send(IPC.permissions.onChange, permissions);
}

function notifySettings(windows: IpcWindowAccessors, settings: AppSettings): void {
  windows.getControlWindow()?.webContents.send(IPC.settings.onChange, settings);
}

function notifySharingState(windows: IpcWindowAccessors): void {
  windows.getOverlayWindow()?.webContents.send(IPC.overlay.onSharingState, sharingState);
}
