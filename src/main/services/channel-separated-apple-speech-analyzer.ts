import type { AudioChunk, Speaker, Transcript } from '@shared/types';
import type { STTProvider } from './stt';

const APPLE_SPEECH_ANALYZER_SPEAKERS: readonly Speaker[] = ['self', 'counterpart'];

export interface AppleSpeechAnalyzerChildProviderContext {
  resolveTimelineOriginMs(chunkStartMs: number): number;
}

export type AppleSpeechAnalyzerChildProviderFactory = (
  speaker: Speaker,
  context: AppleSpeechAnalyzerChildProviderContext,
) => STTProvider;

export interface ChannelSeparatedAppleSpeechAnalyzerSTTProviderOptions {
  createChildProvider: AppleSpeechAnalyzerChildProviderFactory;
}

export class ChannelSeparatedAppleSpeechAnalyzerSTTProvider implements STTProvider {
  private readonly providers: Record<Speaker, STTProvider>;
  private transcriptHandler: ((transcript: Transcript) => void) | null = null;
  private timelineOriginMs: number | null = null;

  private readonly resolveTimelineOriginMs = (chunkStartMs: number): number => {
    this.timelineOriginMs ??= chunkStartMs;
    return this.timelineOriginMs;
  };

  constructor(options: ChannelSeparatedAppleSpeechAnalyzerSTTProviderOptions) {
    const childContext: AppleSpeechAnalyzerChildProviderContext = {
      resolveTimelineOriginMs: this.resolveTimelineOriginMs,
    };
    this.providers = {
      self: options.createChildProvider('self', childContext),
      counterpart: options.createChildProvider('counterpart', childContext),
    };

    for (const speaker of APPLE_SPEECH_ANALYZER_SPEAKERS) {
      this.providers[speaker].setTranscriptHandler?.((transcript) => {
        this.handleChildTranscript(speaker, transcript);
      });
    }
  }

  async connect(): Promise<void> {
    try {
      for (const speaker of APPLE_SPEECH_ANALYZER_SPEAKERS) {
        const provider = this.providers[speaker];
        await provider.connect();
      }
    } catch (error) {
      await Promise.allSettled(
        APPLE_SPEECH_ANALYZER_SPEAKERS.map((speaker) =>
          this.providers[speaker].disconnect(),
        ),
      );
      throw toError(error);
    }
  }

  async disconnect(): Promise<void> {
    try {
      const results = await Promise.allSettled(
        APPLE_SPEECH_ANALYZER_SPEAKERS.map((speaker) => this.providers[speaker].disconnect()),
      );
      const rejected = results.find((result) => result.status === 'rejected');
      if (rejected) {
        throw toError(rejected.reason);
      }
    } finally {
      this.timelineOriginMs = null;
    }
  }

  async sendAudio(chunk: AudioChunk): Promise<void> {
    const provider = this.providers[chunk.speaker];
    await provider.sendAudio({ ...chunk, speaker: chunk.speaker });
  }

  setTranscriptHandler(handler: (transcript: Transcript) => void): void {
    this.transcriptHandler = handler;
  }

  private handleChildTranscript(speaker: Speaker, transcript: Transcript): void {
    const correctedTranscript: Transcript = transcript.isFinal
      ? {
          speaker,
          text: transcript.text,
          isFinal: true,
          startMs: transcript.startMs,
          endMs: transcript.endMs,
        }
      : {
          speaker,
          text: transcript.text,
          isFinal: false,
          startMs: transcript.startMs,
        };

    this.transcriptHandler?.(correctedTranscript);
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
