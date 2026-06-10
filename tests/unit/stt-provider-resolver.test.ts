import { describe, expect, it, vi } from 'vitest';
import type { AudioChunk } from '../../src/shared/types';
import { resolveSTTProvider } from '../../src/main/services/stt-provider-resolver';
import type { STTProvider } from '../../src/main/services/stt';

class FakeProvider implements STTProvider {
  connect = vi.fn(async () => {});
  disconnect = vi.fn(async () => {});
  sendAudio = vi.fn(async (_chunk: AudioChunk) => {});
}

describe('resolveSTTProvider', () => {
  it('uses Apple SpeechAnalyzer when local provider is available', async () => {
    const appleProvider = new FakeProvider();
    const createDeepgramProvider = vi.fn(async () => new FakeProvider());

    const resolved = await resolveSTTProvider({
      mode: 'deepgram_fallback',
      createAppleSpeechAnalyzerProvider: async () => appleProvider,
      createDeepgramProvider,
    });

    expect(resolved.kind).toBe('apple_speech_analyzer');
    expect(resolved.provider).toBe(appleProvider);
    expect(createDeepgramProvider).not.toHaveBeenCalled();
  });

  it('falls back to Deepgram only when fallback mode is explicit', async () => {
    const deepgramProvider = new FakeProvider();
    const createDeepgramProvider = vi.fn(async () => deepgramProvider);

    const resolved = await resolveSTTProvider({
      mode: 'deepgram_fallback',
      createAppleSpeechAnalyzerProvider: async () => null,
      createDeepgramProvider,
    });

    expect(resolved.kind).toBe('deepgram_streaming');
    expect(resolved.provider).toBe(deepgramProvider);
    expect(resolved.degradedReason).toBe('apple_speech_analyzer_unavailable');
    expect(createDeepgramProvider).toHaveBeenCalledWith('counterpart');
  });

  it('does not send local-first mode to Deepgram without explicit fallback', async () => {
    const createDeepgramProvider = vi.fn(async () => new FakeProvider());

    const resolved = await resolveSTTProvider({
      mode: 'local_first',
      createAppleSpeechAnalyzerProvider: async () => null,
      createDeepgramProvider,
    });

    expect(resolved.kind).toBe('apple_speech_analyzer');
    expect(resolved.degradedReason).toBe('apple_speech_analyzer_unavailable');
    expect(createDeepgramProvider).not.toHaveBeenCalled();
    await expect(resolved.provider.connect()).rejects.toThrow('Apple SpeechAnalyzer provider is not available');
  });

  it('keeps manual mode as a no-op STT provider', async () => {
    const createDeepgramProvider = vi.fn(async () => new FakeProvider());
    const resolved = await resolveSTTProvider({
      mode: 'manual_only',
      createDeepgramProvider,
    });

    expect(resolved.kind).toBe('manual');
    await expect(resolved.provider.connect()).resolves.toBeUndefined();
    expect(createDeepgramProvider).not.toHaveBeenCalled();
  });
});
