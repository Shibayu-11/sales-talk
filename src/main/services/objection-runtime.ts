import { IPC } from '@shared/ipc-channels';
import type { BrowserWindow } from 'electron';
import type { ProductId } from '@shared/types';
import { logger } from '../logger';
import { createAnthropicLlmProvider } from './anthropic';
import { createCompanyScopedKnowledgeSearchService } from './company-knowledge-search';
import { ObjectionLlmService } from './llm';
import type { LlmProvider } from './llm';
import { isMockPipelineEnabled } from './dev-mode';
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
    if (isMockPipelineEnabled()) {
      return new DevelopmentMockLlmProvider();
    }
    providerPromise ??= createAnthropicLlmProvider();
    return providerPromise;
  };

  return new ObjectionPipelineService({
    llm: new ObjectionLlmService({
      detectObjection: async (input) => (await getProvider()).detectObjection(input),
      generateObjectionResponse: async (input) => (await getProvider()).generateObjectionResponse(input),
    }),
    knowledge: createCompanyScopedKnowledgeSearchService(),
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
      // Per PRD §4.6: 発話終了→表示 2.5s の実測根拠。商談中(info+)でも必ず残す。
      onTiming: (timing) => {
        logger.info({ metric: 'objection_pipeline_latency', ...timing }, 'objection pipeline latency');
      },
    },
  });
}

class DevelopmentMockLlmProvider implements LlmProvider {
  async detectObjection(input: { utterance: string }): Promise<unknown> {
    return {
      isObjection: true,
      type: inferObjectionType(input.utterance),
      confidence: 0.92,
      triggerText: input.utterance,
      reasoning: 'development mock pipeline',
    };
  }

  async generateObjectionResponse(): Promise<unknown> {
    return {
      layer1Peek: '条件を分解',
      layer2Summary: {
        mainResponse: 'development mock response',
        keyPoints: ['価格の内訳を確認', '導入時期を分ける', '次回判断材料を合意'],
      },
      layer3Detail: {
        fullScript:
          'ありがとうございます。価格だけで判断する前に、対象範囲と導入時期を分けて確認させてください。今すぐ全体導入が難しければ、効果が見えやすい範囲から小さく始め、次回までに費用対効果を判断できる材料を整理します。',
        rationale: '開発用 mock。外部 LLM なしで overlay と pipeline の表示を検証します。',
        cautions: ['本番回答ではありません'],
        similarCases: [],
      },
      confidence: 0.9,
      riskFlags: [],
    };
  }
}

function inferObjectionType(text: string): string {
  if (text.includes('高い') || text.includes('費用') || text.includes('価格')) {
    return 'price';
  }
  if (text.includes('今') || text.includes('時期')) {
    return 'timing';
  }
  return 'status_quo';
}
