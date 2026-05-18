import { contextBridge, ipcRenderer } from 'electron';
import type {
  RendererApi,
  PermissionState,
  CallState,
  AppSettings,
  ProductId,
  KnowledgeEntry,
  Transcript,
  ConnectionState,
} from '@shared/types';

// Keep preload self-contained: sandboxed preload cannot require emitted local chunks.
const IPC = {
  app: { version: 'app:version' },
  permissions: {
    check: 'permissions:check',
    requestScreen: 'permissions:request-screen',
    requestMicrophone: 'permissions:request-microphone',
    onChange: 'permissions:on-change',
  },
  call: {
    start: 'call:start',
    end: 'call:end',
    setProduct: 'call:set-product',
    onState: 'call:on-state',
  },
  audio: {
    status: 'audio:status',
    start: 'audio:start',
    stop: 'audio:stop',
    onError: 'audio:on-error',
  },
  stt: {
    onInterim: 'stt:on-interim',
    onFinal: 'stt:on-final',
    onError: 'stt:on-error',
    onConnectionState: 'stt:on-connection-state',
  },
  objection: {
    onDetected: 'objection:on-detected',
    onResponseReady: 'objection:on-response-ready',
    onCancelled: 'objection:on-cancelled',
    feedback: 'objection:feedback',
    dismiss: 'objection:dismiss',
  },
  overlay: {
    setHover: 'overlay:set-hover',
    setLayer: 'overlay:set-layer',
  },
  knowledge: { search: 'knowledge:search' },
  settings: {
    get: 'settings:get',
    set: 'settings:set',
    onChange: 'settings:on-change',
  },
  secrets: {
    set: 'secrets:set',
    has: 'secrets:has',
    delete: 'secrets:delete',
  },
  dev: {
    isEnabled: 'dev:is-enabled',
    startMockCall: 'dev:start-mock-call',
    endMockCall: 'dev:end-mock-call',
    injectTranscript: 'dev:inject-transcript',
  },
} as const;

/**
 * Control preload — exposes the full RendererApi.
 * Per PRD §23: Renderer never reaches ipcRenderer directly.
 */
const api: RendererApi = {
  app: {
    getVersion: () => ipcRenderer.invoke(IPC.app.version),
  },
  permissions: {
    check: () => ipcRenderer.invoke(IPC.permissions.check),
    requestScreen: () => ipcRenderer.invoke(IPC.permissions.requestScreen),
    requestMicrophone: () => ipcRenderer.invoke(IPC.permissions.requestMicrophone),
    onChange: (cb) => {
      const listener = (_: unknown, s: PermissionState) => cb(s);
      ipcRenderer.on(IPC.permissions.onChange, listener);
      return () => ipcRenderer.off(IPC.permissions.onChange, listener);
    },
  },
  call: {
    start: (productId: ProductId) => ipcRenderer.invoke(IPC.call.start, productId),
    end: () => ipcRenderer.invoke(IPC.call.end),
    setProduct: (productId: ProductId) => ipcRenderer.invoke(IPC.call.setProduct, productId),
    onState: (cb) => {
      const listener = (_: unknown, s: CallState) => cb(s);
      ipcRenderer.on(IPC.call.onState, listener);
      return () => ipcRenderer.off(IPC.call.onState, listener);
    },
  },
  audio: {
    getStatus: () => ipcRenderer.invoke(IPC.audio.status),
    start: () => ipcRenderer.invoke(IPC.audio.start),
    stop: () => ipcRenderer.invoke(IPC.audio.stop),
    onError: (cb) => {
      const listener = (_: unknown, message: string) => cb(message);
      ipcRenderer.on(IPC.audio.onError, listener);
      return () => ipcRenderer.off(IPC.audio.onError, listener);
    },
  },
  stt: {
    onInterim: (cb) => {
      const listener = (_: unknown, transcript: Transcript) => cb(transcript);
      ipcRenderer.on(IPC.stt.onInterim, listener);
      return () => ipcRenderer.off(IPC.stt.onInterim, listener);
    },
    onFinal: (cb) => {
      const listener = (_: unknown, transcript: Transcript) => cb(transcript);
      ipcRenderer.on(IPC.stt.onFinal, listener);
      return () => ipcRenderer.off(IPC.stt.onFinal, listener);
    },
    onError: (cb) => {
      const listener = (_: unknown, message: string) => cb(message);
      ipcRenderer.on(IPC.stt.onError, listener);
      return () => ipcRenderer.off(IPC.stt.onError, listener);
    },
    onConnectionState: (cb) => {
      const listener = (_: unknown, state: ConnectionState) => cb(state);
      ipcRenderer.on(IPC.stt.onConnectionState, listener);
      return () => ipcRenderer.off(IPC.stt.onConnectionState, listener);
    },
  },
  objection: {
    onDetected: (cb) => {
      const listener = (_: unknown, obj: import('@shared/types').DetectedObjection) => cb(obj);
      ipcRenderer.on(IPC.objection.onDetected, listener);
      return () => ipcRenderer.off(IPC.objection.onDetected, listener);
    },
    onResponseReady: (cb) => {
      const listener = (_: unknown, resp: import('@shared/types').ObjectionResponse) => cb(resp);
      ipcRenderer.on(IPC.objection.onResponseReady, listener);
      return () => ipcRenderer.off(IPC.objection.onResponseReady, listener);
    },
    onCancelled: (cb) => {
      const listener = (_: unknown, id: string) => cb(id);
      ipcRenderer.on(IPC.objection.onCancelled, listener);
      return () => ipcRenderer.off(IPC.objection.onCancelled, listener);
    },
    submitFeedback: (id, used, reason) =>
      ipcRenderer.invoke(IPC.objection.feedback, { objectionResponseId: id, used, reason }),
    dismiss: (id) => ipcRenderer.invoke(IPC.objection.dismiss, id),
  },
  overlay: {
    setHover: (isHover) => ipcRenderer.invoke(IPC.overlay.setHover, isHover),
    setLayer: (layer) => ipcRenderer.invoke(IPC.overlay.setLayer, layer),
    onSharingState: () => () => {},
  },
  knowledge: {
    search: (query: string, productId: ProductId, limit?: number): Promise<KnowledgeEntry[]> =>
      ipcRenderer.invoke(IPC.knowledge.search, { query, productId, limit }),
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settings.get),
    set: (patch: Partial<AppSettings>) => ipcRenderer.invoke(IPC.settings.set, patch),
    onChange: (cb) => {
      const listener = (_: unknown, s: AppSettings) => cb(s);
      ipcRenderer.on(IPC.settings.onChange, listener);
      return () => ipcRenderer.off(IPC.settings.onChange, listener);
    },
  },
  secrets: {
    set: (key, value) => ipcRenderer.invoke(IPC.secrets.set, { key, value }),
    has: (key) => ipcRenderer.invoke(IPC.secrets.has, key),
    delete: (key) => ipcRenderer.invoke(IPC.secrets.delete, key),
  },
  dev: {
    isEnabled: () => ipcRenderer.invoke(IPC.dev.isEnabled),
    startMockCall: (productId) => ipcRenderer.invoke(IPC.dev.startMockCall, productId),
    endMockCall: () => ipcRenderer.invoke(IPC.dev.endMockCall),
    injectTranscript: (transcript) => ipcRenderer.invoke(IPC.dev.injectTranscript, transcript),
  },
};

contextBridge.exposeInMainWorld('api', api);
