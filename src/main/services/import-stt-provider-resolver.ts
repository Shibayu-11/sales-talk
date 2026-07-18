/**
 * Resolves the STT provider to use for audio-file import (batch/prerecorded) transcription.
 * Per W3-C: local-first picks Apple SpeechAnalyzer batch when the helper binary is available,
 * and falls back to Deepgram prerecorded.
 */

import type { AudioAsset, AudioSttProvider, SttImportProviderMode, Transcript } from '@shared/types';
import { AppleSpeechAnalyzerBatchTranscriber } from './apple-speech-analyzer-batch';
import { transcribeAudioWithDeepgram } from './audio-stt-job-runner';

export interface BatchTranscriber {
  transcribeFile(asset: AudioAsset, signal?: AbortSignal | undefined): Promise<Transcript[]>;
}

export interface ResolvedImportSTTProvider {
  kind: AudioSttProvider;
  transcriber: BatchTranscriber;
  degradedReason?: string | undefined;
}

export interface ImportSTTProviderResolverOptions {
  mode: SttImportProviderMode;
  /** Injectable for tests: factory for Apple batch transcriber */
  createAppleBatchTranscriber?: () => AppleSpeechAnalyzerBatchTranscriber;
  /** Injectable for tests: Deepgram fallback function */
  deepgramTranscribe?: (
    asset: AudioAsset,
    signal?: AbortSignal | undefined,
  ) => Promise<Transcript[]>;
}

export interface RecordedImportSTTProviderResolverOptions
  extends Omit<ImportSTTProviderResolverOptions, 'mode'> {
  provider: AudioSttProvider;
}

/**
 * Resolves which batch STT provider to use for a file-import job.
 *
 * local_first: use Apple SpeechAnalyzer batch when helper binary is present; else Deepgram.
 * deepgram_only: always use Deepgram prerecorded.
 */
export function resolveImportSTTProvider(
  options: ImportSTTProviderResolverOptions,
): ResolvedImportSTTProvider {
  const deepgramTranscribe = options.deepgramTranscribe ?? transcribeAudioWithDeepgram;
  const deepgramProvider: ResolvedImportSTTProvider = {
    kind: 'deepgram',
    transcriber: { transcribeFile: deepgramTranscribe },
  };

  if (options.mode === 'deepgram_only') {
    return deepgramProvider;
  }

  // local_first
  const appleTranscriber =
    options.createAppleBatchTranscriber?.() ?? new AppleSpeechAnalyzerBatchTranscriber();

  if (!appleTranscriber.isAvailable()) {
    return {
      ...deepgramProvider,
      degradedReason: 'apple_speech_analyzer_unavailable',
    };
  }

  return {
    kind: 'apple_speech_analyzer',
    transcriber: appleTranscriber,
  };
}

export function resolveRecordedImportSTTProvider(
  options: RecordedImportSTTProviderResolverOptions,
): ResolvedImportSTTProvider {
  if (options.provider === 'deepgram') {
    const deepgramTranscribe = options.deepgramTranscribe ?? transcribeAudioWithDeepgram;
    return {
      kind: 'deepgram',
      transcriber: { transcribeFile: deepgramTranscribe },
    };
  }

  const appleTranscriber =
    options.createAppleBatchTranscriber?.() ?? new AppleSpeechAnalyzerBatchTranscriber();
  if (!appleTranscriber.isAvailable()) {
    throw new Error('Apple SpeechAnalyzer batch transcriber is unavailable');
  }

  return {
    kind: 'apple_speech_analyzer',
    transcriber: appleTranscriber,
  };
}
