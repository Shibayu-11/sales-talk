import WebSocket from 'ws';
import { z } from 'zod';
import {
  AUDIO_CHANNELS,
  AUDIO_SAMPLE_RATE,
  DEEPGRAM_ENDPOINTING_MS,
  DEEPGRAM_UTTERANCE_END_MS,
} from '@shared/constants';
import type { AudioChunk, Speaker, Transcript } from '@shared/types';
import { secretStore } from './secrets';
import type { STTProvider } from './stt';

const DEEPGRAM_LISTEN_URL = 'wss://api.deepgram.com/v1/listen';
const DEEPGRAM_MODEL = 'nova-3';
const DEEPGRAM_LANGUAGE = 'ja';

const DeepgramResultsSchema = z.object({
  type: z.string().optional(),
  start: z.number().default(0),
  duration: z.number().default(0),
  is_final: z.boolean().default(false),
  channel: z.object({
    alternatives: z
      .array(
        z.object({
          transcript: z.string().default(''),
        }),
      )
      .min(1),
  }),
});

export interface DeepgramStreamingSTTProviderOptions {
  apiKey: string;
  speaker: Speaker;
  model?: string | undefined;
  language?: string | undefined;
  sampleRate?: number | undefined;
  channels?: number | undefined;
  endpointingMs?: number | undefined;
  utteranceEndMs?: number | undefined;
}

export class DeepgramStreamingSTTProvider implements STTProvider {
  private socket: WebSocket | null = null;
  private transcriptHandler: ((transcript: Transcript) => void) | null = null;

  constructor(private readonly options: DeepgramStreamingSTTProviderOptions) {}

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return;
    }

    const socket = new WebSocket(buildDeepgramListenUrl(this.options), {
      headers: { Authorization: `Token ${this.options.apiKey}` },
    });
    this.socket = socket;

    socket.on('message', (data) => {
      const transcript = parseDeepgramTranscriptMessage(data, this.options.speaker);
      if (transcript) {
        this.transcriptHandler?.(transcript);
      }
    });

    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        socket.off('open', handleOpen);
        socket.off('error', handleError);
      };
      const handleOpen = (): void => {
        cleanup();
        resolve();
      };
      const handleError = (error: Error): void => {
        cleanup();
        reject(error);
      };

      socket.once('open', handleOpen);
      socket.once('error', handleError);
    });
  }

  async disconnect(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      return;
    }

    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.close();
    });
  }

  async sendAudio(chunk: AudioChunk): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Deepgram WebSocket is not connected');
    }

    this.socket.send(Buffer.from(chunk.data, 'base64'));
  }

  setTranscriptHandler(handler: (transcript: Transcript) => void): void {
    this.transcriptHandler = handler;
  }
}

export async function createDeepgramSTTProvider(
  speaker: Speaker = 'counterpart',
): Promise<DeepgramStreamingSTTProvider> {
  const apiKey = (await secretStore.get('deepgram_api_key')) ?? process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    throw new Error('Deepgram API key is not configured');
  }

  return new DeepgramStreamingSTTProvider({ apiKey, speaker });
}

export function parseDeepgramTranscriptMessage(
  data: WebSocket.RawData | string,
  speaker: Speaker,
): Transcript | null {
  const parsedJson = parseJson(rawDataToString(data));
  if (!parsedJson) {
    return null;
  }

  const parsed = DeepgramResultsSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return null;
  }

  const text = parsed.data.channel.alternatives[0]?.transcript.trim();
  if (!text) {
    return null;
  }

  const startMs = secondsToMs(parsed.data.start);
  if (!parsed.data.is_final) {
    return {
      speaker,
      text,
      isFinal: false,
      startMs,
    };
  }

  return {
    speaker,
    text,
    isFinal: true,
    startMs,
    endMs: secondsToMs(parsed.data.start + parsed.data.duration),
  };
}

function buildDeepgramListenUrl(options: DeepgramStreamingSTTProviderOptions): string {
  const url = new URL(DEEPGRAM_LISTEN_URL);
  url.searchParams.set('model', options.model ?? process.env.DEEPGRAM_MODEL ?? DEEPGRAM_MODEL);
  url.searchParams.set('language', options.language ?? DEEPGRAM_LANGUAGE);
  url.searchParams.set('encoding', 'linear16');
  url.searchParams.set('sample_rate', String(options.sampleRate ?? AUDIO_SAMPLE_RATE));
  url.searchParams.set('channels', String(options.channels ?? AUDIO_CHANNELS));
  url.searchParams.set('interim_results', 'true');
  url.searchParams.set('punctuate', 'true');
  url.searchParams.set('smart_format', 'true');
  url.searchParams.set('endpointing', String(options.endpointingMs ?? DEEPGRAM_ENDPOINTING_MS));
  url.searchParams.set('utterance_end_ms', String(options.utteranceEndMs ?? DEEPGRAM_UTTERANCE_END_MS));
  return url.toString();
}

function rawDataToString(data: WebSocket.RawData | string): string {
  if (typeof data === 'string') {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  return Buffer.from(data).toString('utf8');
}

function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function secondsToMs(seconds: number): number {
  return Math.round(seconds * 1_000);
}
