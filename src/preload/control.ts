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
    onDetected: () => () => {},
    onResponseReady: () => () => {},
    onCancelled: () => () => {},
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
};

contextBridge.exposeInMainWorld('api', api);
