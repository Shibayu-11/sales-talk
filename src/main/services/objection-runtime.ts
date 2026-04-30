import { IPC } from '@shared/ipc-channels';
import type { BrowserWindow } from 'electron';
import type { ProductId } from '@shared/types';
import { logger } from '../logger';
import { createAnthropicLlmProvider } from './anthropic';
import { createRuntimeKnowledgeSearchService } from './knowledge-runtime';
import { ObjectionLlmService } from './llm';
import type { LlmProvider } from './llm';
import { ObjectionPipelineService } from './objection-pipeline';

export interface ObjectionRuntimeWindowAccessors {
  getOverlayWindow(): BrowserWindow | null;
  getControlWindow(): BrowserWindow | null;
}

export function createRuntimeObjectionPipelineService(
  windows: ObjectionRuntimeWindowAccessors,
  getProductId: () => ProductId | null,
): ObjectionPipelineService {
  let providerPromise: Promise<LlmProvider> | null = null;
  const getProvider = async (): Promise<LlmProvider> => {
    providerPromise ??= createAnthropicLlmProvider();
    return providerPromise;
  };

  return new ObjectionPipelineService({
    llm: new ObjectionLlmService({
      detectObjection: async (input) => (await getProvider()).detectObjection(input),
      generateObjectionResponse: async (input) => (await getProvider()).generateObjectionResponse(input),
    }),
    knowledge: createRuntimeKnowledgeSearchService(),
    getProductId,
    callbacks: {
      onDetected: (objection) => {
        windows.getOverlayWindow()?.webContents.send(IPC.objection.onDetected, objection);
        windows.getControlWindow()?.webContents.send(IPC.objection.onDetected, objection);
      },
      onResponseReady: (response) => {
        windows.getOverlayWindow()?.webContents.send(IPC.objection.onResponseReady, response);
        windows.getControlWindow()?.webContents.send(IPC.objection.onResponseReady, response);
      },
      onCancelled: (objectionId) => {
        windows.getOverlayWindow()?.webContents.send(IPC.objection.onCancelled, objectionId);
        windows.getControlWindow()?.webContents.send(IPC.objection.onCancelled, objectionId);
      },
      onError: (error) => {
        logger.warn({ error }, 'objection pipeline degraded');
      },
    },
  });
}
