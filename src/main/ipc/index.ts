import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import {
  AppSettingsPatchSchema,
  AudioChunkSchema,
  ComplianceRuleCreateInputSchema,
  ComplianceRuleDeleteInputSchema,
  DevInjectTranscriptInputSchema,
  FeedbackSchema,
  KnowledgeCreateInputSchema,
  KnowledgeDeleteInputSchema,
  KnowledgeSearchInputSchema,
  MinutesGenerateInputSchema,
  ObjectionDismissInputSchema,
  OverlayLayerSchema,
  ProductIdSchema,
  SecretKeySchema,
  SecretSetInputSchema,
  TaskCompleteInputSchema,
  TaskCreateInputSchema,
} from '@shared/schemas';
import type {
  ActionItemTask,
  AppSettings,
  AudioChunk,
  AudioCaptureStatus,
  CallState,
  MeetingMinute,
  PermissionState,
  SharingState,
  Transcript,
} from '@shared/types';
import { logger } from '../logger';
import {
  checkPermissions,
  formatMissingAudioCapturePermissions,
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
import {
  createInitialAudioCaptureStats,
  updateAudioCaptureStats,
} from '../audio/audio-capture-stats';
import {
  getNativeAudioCaptureModuleStatus,
  loadNativeAudioCaptureModule,
} from '../audio/native-module-loader';
import { assertDevToolsEnabled, isDevToolsEnabled } from '../services/dev-mode';
import { localActivityStore } from '../services/local-activity-store';
import { localKnowledgeStore } from '../services/local-knowledge-store';
import { localComplianceStore } from '../services/local-compliance-store';
import { evaluateCompliance } from '../services/compliance';

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
let audioCaptureStats = createInitialAudioCaptureStats();
let activeCallId: string | null = null;
const localSessionId = randomUUID();

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

  ipcMain.handle(IPC.audio.status, () => getAudioCaptureStatus());

  ipcMain.handle(IPC.audio.start, async () => {
    if (!preflightAudioCapturePermissions(windows)) {
      return;
    }
    audioCaptureStats = createInitialAudioCaptureStats();
    await tryStartSTT(windows);
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
    if (!preflightAudioCapturePermissions(windows)) {
      return;
    }
    audioCaptureStats = createInitialAudioCaptureStats();
    activeCallId = randomUUID();
    callState = { status: 'in_call', productId, startedAt: Date.now() };
    await tryStartSTT(windows);
    await tryStartNativeAudioCapture(windows);
    setCallModeLogging(true);
    notifyCallState(windows);
    windows.getOverlayWindow()?.showInactive();
    logger.info({ productId }, 'call started');
  });

  ipcMain.handle(IPC.call.end, () => {
    endCurrentCall(windows);
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

  ipcMain.handle(IPC.knowledge.search, async (_event, payload: unknown) => {
    const input = KnowledgeSearchInputSchema.parse(payload);
    logger.debug({ productId: input.productId, limit: input.limit }, 'knowledge search requested');
    const limit = input.limit ?? 5;
    const localResults = await localKnowledgeStore.search(input.query, input.productId, limit);
    const remoteResults = await knowledgeSearchService.search({
      query: input.query,
      productId: input.productId,
      limit,
    });
    return [...localResults, ...remoteResults].slice(0, limit);
  });
  ipcMain.handle(IPC.knowledge.list, (_event, payload: unknown) => {
    const productId = ProductIdSchema.parse(payload);
    return localKnowledgeStore.list(productId);
  });
  ipcMain.handle(IPC.knowledge.create, (_event, payload: unknown) => {
    const input = KnowledgeCreateInputSchema.parse(payload);
    return localKnowledgeStore.create(input);
  });
  ipcMain.handle(IPC.knowledge.delete, async (_event, payload: unknown) => {
    const id = KnowledgeDeleteInputSchema.parse(payload);
    await localKnowledgeStore.delete(id);
  });

  ipcMain.handle(IPC.minutes.generate, async (_event, payload: unknown) => {
    const input = MinutesGenerateInputSchema.parse(payload);
    return localActivityStore.setLatestMeetingMinute(
      await generateLocalMeetingMinute(input.productId, input.transcripts, input.source),
    );
  });
  ipcMain.handle(IPC.minutes.get, () => localActivityStore.getLatestMeetingMinute());

  ipcMain.handle(IPC.tasks.list, () => localActivityStore.listTasks());
  ipcMain.handle(IPC.tasks.create, async (_event, payload: unknown) => {
    const input = TaskCreateInputSchema.parse(payload);
    const task: ActionItemTask = {
      id: randomUUID(),
      callId: getCurrentCallId(),
      owner: input.owner,
      description: input.description,
      due: { kind: 'none' },
      completed: false,
      createdAt: new Date().toISOString(),
    };
    return localActivityStore.createTask(task);
  });
  ipcMain.handle(IPC.tasks.complete, (_event, payload: unknown) => {
    const input = TaskCompleteInputSchema.parse(payload);
    return localActivityStore.completeTask(input.id, input.completed);
  });

  ipcMain.handle(IPC.compliance.rulesList, () => localComplianceStore.listRules());
  ipcMain.handle(IPC.compliance.rulesCreate, (_event, payload: unknown) => {
    const input = ComplianceRuleCreateInputSchema.parse(payload);
    return localComplianceStore.createRule(input);
  });
  ipcMain.handle(IPC.compliance.rulesDelete, async (_event, payload: unknown) => {
    const id = ComplianceRuleDeleteInputSchema.parse(payload);
    await localComplianceStore.deleteRule(id);
  });

  ipcMain.handle(IPC.objection.feedback, (_event, payload: unknown) => {
    const feedback = FeedbackSchema.parse(payload);
    logger.info({ objectionResponseId: feedback.objectionResponseId, used: feedback.used }, 'feedback');
  });

  ipcMain.handle(IPC.objection.dismiss, (_event, payload: unknown) => {
    const id = ObjectionDismissInputSchema.parse(payload);
    activeObjectionPipelineService?.cancelActive();
    notifyObjectionCancelled(windows, id);
    logger.info({ id }, 'objection dismissed');
  });

  ipcMain.handle(IPC.dev.isEnabled, () => isDevToolsEnabled());
  ipcMain.handle(IPC.dev.startMockCall, (_event, payload: unknown) => {
    assertDevToolsEnabled();
    const productId = ProductIdSchema.parse(payload);
    activeCallId = randomUUID();
    callState = { status: 'in_call', productId, startedAt: Date.now() };
    setCallModeLogging(true);
    notifyCallState(windows);
    windows.getOverlayWindow()?.showInactive();
    logger.info({ productId }, 'development mock call started');
  });
  ipcMain.handle(IPC.dev.endMockCall, () => {
    assertDevToolsEnabled();
    endCurrentCall(windows);
    logger.info('development mock call ended');
  });
  ipcMain.handle(IPC.dev.injectTranscript, async (_event, payload: unknown) => {
    assertDevToolsEnabled();
    const transcript = DevInjectTranscriptInputSchema.parse(payload);
    notifyTranscript(windows, transcript);
    if (callState.status === 'in_call') {
      await handlePipelineTranscript(transcript);
    }
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
  audioCaptureStats = updateAudioCaptureStats(audioCaptureStats, chunk);
  await activeSttClient?.sendAudio(chunk);
}

function getAudioCaptureStatus(): AudioCaptureStatus {
  return {
    nativeModule: getNativeAudioCaptureModuleStatus(),
    permissions: checkPermissions(),
    stats: audioCaptureStats,
    sttState: activeSttClient?.getState() ?? 'disconnected',
    nativeCaptureActive: activeNativeAudioCaptureService !== null,
  };
}

function preflightAudioCapturePermissions(windows: IpcWindowAccessors): boolean {
  const permissions = checkPermissions();
  notifyPermissions(windows, permissions);
  const message = formatMissingAudioCapturePermissions(permissions);
  if (!message) {
    return true;
  }

  windows.getControlWindow()?.webContents.send(IPC.audio.onError, message);
  logger.warn({ permissions }, 'audio capture permission preflight failed');
  return false;
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

function notifyTranscript(windows: IpcWindowAccessors, transcript: Transcript): void {
  const channel = transcript.isFinal ? IPC.stt.onFinal : IPC.stt.onInterim;
  windows.getControlWindow()?.webContents.send(channel, transcript);
}

function notifyObjectionCancelled(windows: IpcWindowAccessors, id: string): void {
  windows.getControlWindow()?.webContents.send(IPC.objection.onCancelled, id);
  windows.getOverlayWindow()?.webContents.send(IPC.objection.onCancelled, id);
}

async function generateLocalMeetingMinute(
  productId: MeetingMinute['productId'],
  transcripts: Transcript[],
  source: MeetingMinute['source'],
): Promise<MeetingMinute> {
  const finalTexts = transcripts
    .filter((transcript) => transcript.isFinal)
    .map((transcript) => transcript.text.trim())
    .filter((text) => text.length > 0);
  const summarySource = finalTexts[0] ?? '商談 transcript はまだありません。';
  const pending = finalTexts.filter((text) =>
    ['高い', '難しい', '検討', '確認', '次回'].some((keyword) => text.includes(keyword)),
  );
  const rules = await localComplianceStore.listRules('insurance');

  return {
    id: randomUUID(),
    callId: getCurrentCallId(),
    source,
    productId,
    summary: `直近の発話: ${summarySource}`,
    agreed: [],
    pending: pending.slice(0, 5),
    decisions: [],
    numbers: extractNumbers(finalTexts.join('\n')),
    complianceFindings: evaluateCompliance({
      meetingId: getCurrentCallId(),
      transcripts,
      rules,
    }),
    generatedAt: new Date().toISOString(),
  };
}

function extractNumbers(text: string): MeetingMinute['numbers'] {
  const matches = text.match(/\d[\d,]*(?:円|万円|%|％|ヶ月|か月|月|日)?/g) ?? [];
  return [...new Set(matches)].slice(0, 10).map((value, index) => ({
    label: `number_${index + 1}`,
    value,
  }));
}

function getCurrentCallId(): string {
  return activeCallId ?? localSessionId;
}

function endCurrentCall(windows: IpcWindowAccessors): void {
  callState = { status: 'idle' };
  activeObjectionPipelineService?.cancelActive();
  void stopNativeAudioCapture();
  void stopSTT();
  setCallModeLogging(false);
  notifyCallState(windows);
  windows.getOverlayWindow()?.hide();
}
