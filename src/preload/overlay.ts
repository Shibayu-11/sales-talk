import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '@shared/ipc-channels';
import type { RendererApi, SharingState, DetectedObjection, ObjectionResponse } from '@shared/types';

/**
 * Overlay preload — exposes a minimal slice of RendererApi.
 * Per PRD §23: Renderer never sees IPC channels directly.
 */
const api: Pick<RendererApi, 'overlay' | 'objection' | 'app'> = {
  app: {
    getVersion: () => ipcRenderer.invoke(IPC.app.version),
  },
  overlay: {
    setHover: (isHover) => ipcRenderer.invoke(IPC.overlay.setHover, isHover),
    setLayer: (layer) => ipcRenderer.invoke(IPC.overlay.setLayer, layer),
    onSharingState: (cb) => {
      const listener = (_: unknown, state: SharingState) => cb(state);
      ipcRenderer.on(IPC.overlay.onSharingState, listener);
      return () => ipcRenderer.off(IPC.overlay.onSharingState, listener);
    },
  },
  objection: {
    onDetected: (cb) => {
      const listener = (_: unknown, obj: DetectedObjection) => cb(obj);
      ipcRenderer.on(IPC.objection.onDetected, listener);
      return () => ipcRenderer.off(IPC.objection.onDetected, listener);
    },
    onResponseReady: (cb) => {
      const listener = (_: unknown, resp: ObjectionResponse) => cb(resp);
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
};

contextBridge.exposeInMainWorld('api', api);
