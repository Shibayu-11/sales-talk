import { describe, expect, it, vi } from 'vitest';
import { resolveImportSTTProvider } from '../../src/main/services/import-stt-provider-resolver';
import { AppleSpeechAnalyzerBatchTranscriber } from '../../src/main/services/apple-speech-analyzer-batch';

describe('resolveImportSTTProvider', () => {
  it('picks Apple batch transcriber when helper is available in local_first mode', () => {
    const appleTranscriber = { isAvailable: vi.fn(() => true), transcribeFile: vi.fn() } as unknown as AppleSpeechAnalyzerBatchTranscriber;

    const resolved = resolveImportSTTProvider({
      mode: 'local_first',
      createAppleBatchTranscriber: () => appleTranscriber,
    });

    expect(resolved.kind).toBe('apple_speech_analyzer');
    expect(resolved.transcriber).toBe(appleTranscriber);
    expect(resolved.degradedReason).toBeUndefined();
  });

  it('falls back to Deepgram when Apple helper is unavailable in local_first mode', () => {
    const appleTranscriber = { isAvailable: vi.fn(() => false), transcribeFile: vi.fn() } as unknown as AppleSpeechAnalyzerBatchTranscriber;
    const deepgramTranscribe = vi.fn(async () => []);

    const resolved = resolveImportSTTProvider({
      mode: 'local_first',
      createAppleBatchTranscriber: () => appleTranscriber,
      deepgramTranscribe,
    });

    expect(resolved.kind).toBe('deepgram');
    expect(resolved.degradedReason).toBe('apple_speech_analyzer_unavailable');
    // The transcriber wraps deepgramTranscribe
    expect(resolved.transcriber).toBeDefined();
  });

  it('always uses Deepgram in deepgram_only mode regardless of helper availability', () => {
    const appleTranscriber = { isAvailable: vi.fn(() => true), transcribeFile: vi.fn() } as unknown as AppleSpeechAnalyzerBatchTranscriber;
    const deepgramTranscribe = vi.fn(async () => []);

    const resolved = resolveImportSTTProvider({
      mode: 'deepgram_only',
      createAppleBatchTranscriber: () => appleTranscriber,
      deepgramTranscribe,
    });

    expect(resolved.kind).toBe('deepgram');
    expect(resolved.degradedReason).toBeUndefined();
    // Apple transcriber isAvailable should not have been called
    expect(appleTranscriber.isAvailable).not.toHaveBeenCalled();
  });

  it('Deepgram transcriber delegate calls deepgramTranscribe', async () => {
    const transcript = { speaker: 'counterpart' as const, text: 'test', isFinal: true as const, startMs: 0, endMs: 100 };
    const deepgramTranscribe = vi.fn(async () => [transcript]);
    const appleTranscriber = { isAvailable: vi.fn(() => false), transcribeFile: vi.fn() } as unknown as AppleSpeechAnalyzerBatchTranscriber;

    const resolved = resolveImportSTTProvider({
      mode: 'local_first',
      createAppleBatchTranscriber: () => appleTranscriber,
      deepgramTranscribe,
    });

    const fakeAsset = { id: 'a', callId: 'c', fileName: 'f.m4a', originalPath: '/tmp/f.m4a', storedPath: '/tmp/f.m4a', mimeType: 'audio/mp4', sizeBytes: 0, createdAt: '' };
    const result = await resolved.transcriber.transcribeFile(fakeAsset);
    expect(deepgramTranscribe).toHaveBeenCalledWith(fakeAsset);
    expect(result).toEqual([transcript]);
  });
});
