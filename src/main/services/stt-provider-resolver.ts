import type { Speaker, SttProviderKind, SttProviderMode } from '@shared/types';
import { createDeepgramSTTProvider } from './deepgram';
import type { STTProvider } from './stt';

export interface ResolvedSTTProvider {
  provider: STTProvider;
  kind: SttProviderKind;
  degradedReason?: string;
}

export interface STTProviderResolverOptions {
  mode: SttProviderMode;
  speaker?: Speaker;
  createAppleSpeechAnalyzerProvider?: () => Promise<STTProvider | null>;
  createDeepgramProvider?: (speaker: Speaker) => Promise<STTProvider>;
}

export async function resolveSTTProvider(options: STTProviderResolverOptions): Promise<ResolvedSTTProvider> {
  const speaker = options.speaker ?? 'counterpart';
  const createAppleProvider = options.createAppleSpeechAnalyzerProvider ?? createUnavailableAppleProvider;
  const createDeepgramProvider = options.createDeepgramProvider ?? createDeepgramSTTProvider;

  if (options.mode === 'manual_only') {
    return { provider: new ManualTranscriptOnlySTTProvider(), kind: 'manual' };
  }

  if (options.mode === 'deepgram_only') {
    return { provider: await createDeepgramProvider(speaker), kind: 'deepgram_streaming' };
  }

  const appleProvider = await createAppleProvider();
  if (appleProvider) {
    return { provider: appleProvider, kind: 'apple_speech_analyzer' };
  }

  if (options.mode === 'deepgram_fallback') {
    return {
      provider: await createDeepgramProvider(speaker),
      kind: 'deepgram_streaming',
      degradedReason: 'apple_speech_analyzer_unavailable',
    };
  }

  return {
    provider: new UnavailableSTTProvider('Apple SpeechAnalyzer provider is not available in this build'),
    kind: 'apple_speech_analyzer',
    degradedReason: 'apple_speech_analyzer_unavailable',
  };
}

class ManualTranscriptOnlySTTProvider implements STTProvider {
  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  async sendAudio(): Promise<void> {}
}

class UnavailableSTTProvider implements STTProvider {
  constructor(private readonly message: string) {}

  async connect(): Promise<void> {
    throw new Error(this.message);
  }

  async disconnect(): Promise<void> {}

  async sendAudio(): Promise<void> {
    throw new Error(this.message);
  }
}

async function createUnavailableAppleProvider(): Promise<STTProvider | null> {
  return null;
}
