/* eslint-disable no-console */
import { Worker } from 'node:worker_threads';
import WebSocket, { type RawData } from 'ws';
import { z } from 'zod';
import { nativeChunkToAudioChunk, type NativeAudioSource, type NativeCaptureError } from '../src/main/audio/native-audio-capture';
import {
  getNativeAudioCaptureModuleStatus,
  loadNativeAudioCaptureModule,
  resolveNativeAudioCaptureModulePath,
} from '../src/main/audio/native-module-loader';

interface SttSmokeOptions {
  connectTimeoutMs: number;
  deepgramApiKey: string | null;
  durationMs: number;
  modulePath: string;
  requireTranscript: boolean;
  sampleRate: number;
  source: NativeAudioSource;
  startTimeoutMs: number;
  targetAppBundleId: string;
}

interface SttSmokeStats {
  capturedChunks: number;
  sentChunks: number;
  sentBytes: number;
  transcripts: string[];
  nativeErrors: NativeCaptureError[];
  sttErrors: string[];
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_DURATION_MS = 8_000;
const DEFAULT_SAMPLE_RATE = 16_000;
const DEFAULT_SOURCE: NativeAudioSource = 'microphone';
const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_TARGET_APP_BUNDLE_ID = 'us.zoom.xos';
const DEEPGRAM_LISTEN_URL = 'wss://api.deepgram.com/v1/listen';

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

function parseOptions(argv: string[]): SttSmokeOptions {
  const options: SttSmokeOptions = {
    connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
    deepgramApiKey: process.env.DEEPGRAM_API_KEY ?? null,
    durationMs: DEFAULT_DURATION_MS,
    modulePath: resolveNativeAudioCaptureModulePath(),
    requireTranscript: false,
    sampleRate: DEFAULT_SAMPLE_RATE,
    source: DEFAULT_SOURCE,
    startTimeoutMs: DEFAULT_START_TIMEOUT_MS,
    targetAppBundleId: DEFAULT_TARGET_APP_BUNDLE_ID,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }

    const [name, inlineValue] = arg.split('=', 2);
    const nextValue = inlineValue ?? argv[index + 1];
    const consumedNext = inlineValue === undefined;

    switch (name) {
      case '--connect-timeout-ms':
        options.connectTimeoutMs = parsePositiveInteger(nextValue, '--connect-timeout-ms');
        if (consumedNext) index += 1;
        break;
      case '--deepgram-api-key':
        options.deepgramApiKey = parseNonEmptyString(nextValue, '--deepgram-api-key');
        if (consumedNext) index += 1;
        break;
      case '--duration-ms':
        options.durationMs = parsePositiveInteger(nextValue, '--duration-ms');
        if (consumedNext) index += 1;
        break;
      case '--module-path':
        options.modulePath = parseNonEmptyString(nextValue, '--module-path');
        if (consumedNext) index += 1;
        break;
      case '--require-transcript':
        options.requireTranscript = true;
        break;
      case '--sample-rate':
        options.sampleRate = parsePositiveInteger(nextValue, '--sample-rate');
        if (consumedNext) index += 1;
        break;
      case '--source':
        options.source = parseSource(nextValue);
        if (consumedNext) index += 1;
        break;
      case '--start-timeout-ms':
        options.startTimeoutMs = parsePositiveInteger(nextValue, '--start-timeout-ms');
        if (consumedNext) index += 1;
        break;
      case '--target-bundle-id':
        options.targetAppBundleId = parseNonEmptyString(nextValue, '--target-bundle-id');
        if (consumedNext) index += 1;
        break;
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function parseSource(value: string | undefined): NativeAudioSource {
  if (value === 'microphone' || value === 'system') {
    return value;
  }
  throw new Error('--source must be microphone or system');
}

function parsePositiveInteger(value: string | undefined, name: string): number {
  if (!value) {
    throw new Error(`${name} requires a value`);
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseNonEmptyString(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

async function runSttSmoke(options: SttSmokeOptions): Promise<number> {
  if (!options.deepgramApiKey) {
    console.error('[audio-stt-smoke] DEEPGRAM_API_KEY is required');
    return 1;
  }

  const moduleStatus = getNativeAudioCaptureModuleStatus(options.modulePath);
  console.info('[audio-stt-smoke] module', moduleStatus);

  const nativeModule = loadNativeAudioCaptureModule(options.modulePath);
  if (!nativeModule) {
    console.error(`[audio-stt-smoke] native module not found: ${options.modulePath}`);
    return 1;
  }

  const stats: SttSmokeStats = {
    capturedChunks: 0,
    sentChunks: 0,
    sentBytes: 0,
    transcripts: [],
    nativeErrors: [],
    sttErrors: [],
  };
  const deepgram = new DeepgramProbe({
    apiKey: options.deepgramApiKey,
    connectTimeoutMs: options.connectTimeoutMs,
    onError: (message) => {
      stats.sttErrors.push(message);
      console.warn(`[audio-stt-smoke] deepgram error=${message}`);
    },
    onTranscript: (transcript) => {
      stats.transcripts.push(transcript);
      console.info(`[audio-stt-smoke] transcript=${transcript}`);
    },
    sampleRate: options.sampleRate,
  });

  let sessionId: string | null = null;
  try {
    await deepgram.connect();
    console.info(`[audio-stt-smoke] deepgram connected source=${options.source}`);

    nativeModule.onError((error) => {
      stats.nativeErrors.push(error);
      console.warn(`[audio-stt-smoke] native error code=${error.code} message=${error.message}`);
    });
    nativeModule.onAudioChunk((chunk) => {
      if (chunk.source !== options.source) {
        return;
      }

      stats.capturedChunks += 1;
      const audioChunk = nativeChunkToAudioChunk(chunk);
      const audioBuffer = Buffer.from(audioChunk.data, 'base64');
      stats.sentChunks += 1;
      stats.sentBytes += audioBuffer.byteLength;
      deepgram.send(audioBuffer);
    });

    const session = await withProcessWatchdog(
      `startCapture exceeded ${options.startTimeoutMs}ms. Check Microphone/Screen Recording permission prompts.`,
      options.startTimeoutMs,
      () =>
        nativeModule.startCapture({
          sampleRate: options.sampleRate,
          targetAppBundleId: options.targetAppBundleId,
        }),
    );
    sessionId = session.sessionId;
    console.info(
      `[audio-stt-smoke] started session=${session.sessionId} durationMs=${options.durationMs} target=${options.targetAppBundleId}`,
    );
    await wait(options.durationMs);
  } catch (error) {
    console.error('[audio-stt-smoke] failed', error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await stopCapture(nativeModule, sessionId);
    await deepgram.disconnect();
  }

  printSummary(stats);
  return isSuccessful(stats, options) ? 0 : 1;
}

interface DeepgramProbeOptions {
  apiKey: string;
  connectTimeoutMs: number;
  onError: (message: string) => void;
  onTranscript: (transcript: string) => void;
  sampleRate: number;
}

class DeepgramProbe {
  private socket: WebSocket | null = null;

  constructor(private readonly options: DeepgramProbeOptions) {}

  async connect(): Promise<void> {
    const socket = new WebSocket(buildDeepgramUrl(this.options.sampleRate), {
      headers: { Authorization: `Token ${this.options.apiKey}` },
    });
    this.socket = socket;

    socket.on('message', (data) => {
      const transcript = parseTranscript(data);
      if (transcript) {
        this.options.onTranscript(transcript);
      }
    });
    socket.on('error', (error) => {
      this.options.onError(error.message);
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Deepgram connect exceeded ${this.options.connectTimeoutMs}ms`));
      }, this.options.connectTimeoutMs);
      const cleanup = (): void => {
        clearTimeout(timeout);
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

  send(data: Buffer): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }
    this.socket.send(data);
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
}

function buildDeepgramUrl(sampleRate: number): string {
  const url = new URL(DEEPGRAM_LISTEN_URL);
  url.searchParams.set('model', process.env.DEEPGRAM_MODEL ?? 'nova-3');
  url.searchParams.set('language', 'ja');
  url.searchParams.set('encoding', 'linear16');
  url.searchParams.set('sample_rate', String(sampleRate));
  url.searchParams.set('channels', '1');
  url.searchParams.set('interim_results', 'true');
  url.searchParams.set('punctuate', 'true');
  url.searchParams.set('smart_format', 'true');
  url.searchParams.set('endpointing', '500');
  url.searchParams.set('utterance_end_ms', '1000');
  return url.toString();
}

function parseTranscript(data: RawData): string | null {
  const parsedJson = parseJson(rawDataToString(data));
  if (!parsedJson) {
    return null;
  }

  const parsed = DeepgramResultsSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return null;
  }

  return parsed.data.channel.alternatives[0]?.transcript.trim() || null;
}

function rawDataToString(data: RawData): string {
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

async function stopCapture(
  nativeModule: { stopCapture(sessionId: string): Promise<void> },
  sessionId: string | null,
): Promise<void> {
  if (!sessionId) {
    return;
  }

  try {
    await nativeModule.stopCapture(sessionId);
  } catch (error) {
    console.warn('[audio-stt-smoke] stop failed', error instanceof Error ? error.message : String(error));
  }
}

function printSummary(stats: SttSmokeStats): void {
  console.info('[audio-stt-smoke] summary');
  console.info(`[audio-stt-smoke] capturedChunks=${stats.capturedChunks}`);
  console.info(`[audio-stt-smoke] sentChunks=${stats.sentChunks} sentBytes=${stats.sentBytes}`);
  console.info(`[audio-stt-smoke] transcripts=${stats.transcripts.length}`);
  console.info(`[audio-stt-smoke] nativeErrors=${stats.nativeErrors.length} sttErrors=${stats.sttErrors.length}`);
}

function isSuccessful(stats: SttSmokeStats, options: SttSmokeOptions): boolean {
  if (stats.sentChunks === 0) {
    console.error(`[audio-stt-smoke] failed: no ${options.source} audio chunks sent`);
    return false;
  }

  if (options.requireTranscript && stats.transcripts.length === 0) {
    console.error('[audio-stt-smoke] failed: no transcripts received');
    return false;
  }

  return true;
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

async function withProcessWatchdog<T>(
  timeoutMessage: string,
  timeoutMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  const watchdog = new Worker(
    `
      const { workerData } = require('node:worker_threads');
      setTimeout(() => {
        console.error('[audio-stt-smoke] timeout: ' + workerData.message);
        process.kill(workerData.pid, 'SIGTERM');
      }, workerData.timeoutMs);
    `,
    {
      eval: true,
      workerData: {
        message: timeoutMessage,
        pid: process.pid,
        timeoutMs,
      },
    },
  );

  try {
    return await operation();
  } finally {
    await watchdog.terminate();
  }
}

function printHelp(): void {
  console.info(`Usage: DEEPGRAM_API_KEY=... npm run native:audio:stt-smoke -- [options]

Options:
  --source <microphone|system>  Audio source to send to Deepgram. Default: ${DEFAULT_SOURCE}
  --duration-ms <ms>            Capture duration. Default: ${DEFAULT_DURATION_MS}
  --target-bundle-id <id>       Target app for system audio. Default: ${DEFAULT_TARGET_APP_BUNDLE_ID}
  --sample-rate <hz>            Capture sample rate. Default: ${DEFAULT_SAMPLE_RATE}
  --start-timeout-ms <ms>       Kill the process if native start blocks. Default: ${DEFAULT_START_TIMEOUT_MS}
  --connect-timeout-ms <ms>     Deepgram connect timeout. Default: ${DEFAULT_CONNECT_TIMEOUT_MS}
  --module-path <path>          Override audio_capture.node path
  --deepgram-api-key <key>      Override DEEPGRAM_API_KEY. Prefer env var to avoid shell history.
  --require-transcript          Fail when no transcript is received
  --help                        Show this help
`);
}

async function main(): Promise<void> {
  try {
    const options = parseOptions(process.argv.slice(2));
    const exitCode = await runSttSmoke(options);
    process.exit(exitCode);
  } catch (error) {
    console.error('[audio-stt-smoke] failed', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

void main();
