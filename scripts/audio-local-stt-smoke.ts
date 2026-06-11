/* eslint-disable no-console */
import { Worker } from 'node:worker_threads';
import type { Transcript } from '../src/shared/types';
import { nativeChunkToAudioChunk, type NativeAudioSource, type NativeCaptureError } from '../src/main/audio/native-audio-capture';
import {
  getNativeAudioCaptureModuleStatus,
  loadNativeAudioCaptureModule,
  resolveNativeAudioCaptureModulePath,
} from '../src/main/audio/native-module-loader';
import { AppleSpeechAnalyzerSTTProvider } from '../src/main/services/apple-speech-analyzer';
import { ObjectionLlmService, type LlmProvider } from '../src/main/services/llm';
import { ObjectionPipelineService } from '../src/main/services/objection-pipeline';
import { EmptyKnowledgeRepository, KnowledgeSearchService } from '../src/main/services/knowledge';

interface LocalSttSmokeOptions {
  durationMs: number;
  helperPath: string | null;
  modulePath: string;
  requirePipeline: boolean;
  requireTranscript: boolean;
  sampleRate: number;
  source: NativeAudioSource;
  startTimeoutMs: number;
  targetAppBundleId: string;
}

interface LocalSttSmokeStats {
  capturedChunks: number;
  sentChunks: number;
  sentBytes: number;
  transcripts: Transcript[];
  pipelineDetected: number;
  pipelineResponses: number;
  nativeErrors: NativeCaptureError[];
  sttErrors: string[];
  pipelineErrors: string[];
}

const DEFAULT_DURATION_MS = 12_000;
const DEFAULT_SAMPLE_RATE = 16_000;
const DEFAULT_SOURCE: NativeAudioSource = 'microphone';
const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_TARGET_APP_BUNDLE_ID = 'us.zoom.xos';

function parseOptions(argv: string[]): LocalSttSmokeOptions {
  const options: LocalSttSmokeOptions = {
    durationMs: DEFAULT_DURATION_MS,
    helperPath: null,
    modulePath: resolveNativeAudioCaptureModulePath(),
    requirePipeline: false,
    requireTranscript: false,
    sampleRate: DEFAULT_SAMPLE_RATE,
    source: DEFAULT_SOURCE,
    startTimeoutMs: DEFAULT_START_TIMEOUT_MS,
    targetAppBundleId: DEFAULT_TARGET_APP_BUNDLE_ID,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;

    const [name, inlineValue] = arg.split('=', 2);
    const nextValue = inlineValue ?? argv[index + 1];
    const consumedNext = inlineValue === undefined;

    switch (name) {
      case '--duration-ms':
        options.durationMs = parsePositiveInteger(nextValue, '--duration-ms');
        if (consumedNext) index += 1;
        break;
      case '--helper-path':
        options.helperPath = parseNonEmptyString(nextValue, '--helper-path');
        if (consumedNext) index += 1;
        break;
      case '--module-path':
        options.modulePath = parseNonEmptyString(nextValue, '--module-path');
        if (consumedNext) index += 1;
        break;
      case '--require-pipeline':
        options.requirePipeline = true;
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
  if (value === 'microphone' || value === 'system') return value;
  throw new Error('--source must be microphone or system');
}

function parsePositiveInteger(value: string | undefined, name: string): number {
  if (!value) throw new Error(`${name} requires a value`);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseNonEmptyString(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

async function runLocalSttSmoke(options: LocalSttSmokeOptions): Promise<number> {
  const moduleStatus = getNativeAudioCaptureModuleStatus(options.modulePath);
  console.info('[audio-local-stt-smoke] module', moduleStatus);

  const nativeModule = loadNativeAudioCaptureModule(options.modulePath);
  if (!nativeModule) {
    console.error(`[audio-local-stt-smoke] native module not found: ${options.modulePath}`);
    return 1;
  }

  const stats = createStats();
  const pipeline = createSmokePipeline(stats);
  const provider = new AppleSpeechAnalyzerSTTProvider({
    helperPath: options.helperPath ?? undefined,
    sampleRate: options.sampleRate,
  });
  provider.setTranscriptHandler((transcript) => {
    stats.transcripts.push(transcript);
    console.info(`[audio-local-stt-smoke] transcript final=${transcript.isFinal} text=${transcript.text}`);
    void pipeline.handleTranscript(transcript);
  });

  let sessionId: string | null = null;
  try {
    await provider.connect();
    console.info(`[audio-local-stt-smoke] speech analyzer connected source=${options.source}`);

    nativeModule.onError((error) => {
      stats.nativeErrors.push(error);
      console.warn(`[audio-local-stt-smoke] native error code=${error.code} message=${error.message}`);
    });
    nativeModule.onAudioChunk((chunk) => {
      if (chunk.source !== options.source) {
        return;
      }

      const audioChunk = nativeChunkToAudioChunk(chunk);
      stats.capturedChunks += 1;
      stats.sentChunks += 1;
      stats.sentBytes += Buffer.byteLength(audioChunk.data, 'base64');
      void provider.sendAudio(audioChunk).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        stats.sttErrors.push(message);
        console.warn(`[audio-local-stt-smoke] stt error=${message}`);
      });
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
      `[audio-local-stt-smoke] started session=${session.sessionId} durationMs=${options.durationMs} target=${options.targetAppBundleId}`,
    );
    await wait(options.durationMs);
  } catch (error) {
    console.error('[audio-local-stt-smoke] failed', error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await stopCapture(nativeModule, sessionId);
    await provider.disconnect();
  }

  printSummary(stats);
  return isSuccessful(stats, options) ? 0 : 1;
}

function createStats(): LocalSttSmokeStats {
  return {
    capturedChunks: 0,
    sentChunks: 0,
    sentBytes: 0,
    transcripts: [],
    pipelineDetected: 0,
    pipelineResponses: 0,
    nativeErrors: [],
    sttErrors: [],
    pipelineErrors: [],
  };
}

function createSmokePipeline(stats: LocalSttSmokeStats): ObjectionPipelineService {
  return new ObjectionPipelineService({
    llm: new ObjectionLlmService(new SmokeLlmProvider()),
    knowledge: new KnowledgeSearchService(new EmptyKnowledgeRepository()),
    getProductId: () => 'real_estate',
    callbacks: {
      onDetected: (objection) => {
        stats.pipelineDetected += 1;
        console.info(`[audio-local-stt-smoke] pipeline detected type=${objection.type}`);
      },
      onResponseReady: (response) => {
        stats.pipelineResponses += 1;
        console.info(`[audio-local-stt-smoke] pipeline response peak=${response.peak}`);
      },
      onError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        stats.pipelineErrors.push(message);
        console.warn(`[audio-local-stt-smoke] pipeline error=${message}`);
      },
    },
  });
}

class SmokeLlmProvider implements LlmProvider {
  async detectObjection(input: { utterance: string }): Promise<unknown> {
    return {
      isObjection: true,
      type: input.utterance.includes('高い') ? 'price' : 'status_quo',
      confidence: 0.9,
      triggerText: input.utterance,
      reasoning: 'local STT smoke',
    };
  }

  async generateObjectionResponse(): Promise<unknown> {
    return {
      layer1Peek: '条件を分解',
      layer2Summary: {
        mainResponse: '価格だけでなく対象範囲と導入時期を分けて確認しましょう。',
        keyPoints: ['対象範囲を確認', '費用対効果を整理', '次回判断材料を合意'],
      },
      layer3Detail: {
        fullScript: '価格だけでなく対象範囲と導入時期を分けて確認しましょう。',
        rationale: 'local STT smoke',
        cautions: [],
        similarCases: [],
      },
      confidence: 0.9,
      riskFlags: [],
    };
  }
}

async function stopCapture(
  nativeModule: { stopCapture(sessionId: string): Promise<void> },
  sessionId: string | null,
): Promise<void> {
  if (!sessionId) return;

  try {
    await nativeModule.stopCapture(sessionId);
  } catch (error) {
    console.warn('[audio-local-stt-smoke] stop failed', error instanceof Error ? error.message : String(error));
  }
}

function printSummary(stats: LocalSttSmokeStats): void {
  console.info('[audio-local-stt-smoke] summary');
  console.info(`[audio-local-stt-smoke] capturedChunks=${stats.capturedChunks}`);
  console.info(`[audio-local-stt-smoke] sentChunks=${stats.sentChunks} sentBytes=${stats.sentBytes}`);
  console.info(`[audio-local-stt-smoke] transcripts=${stats.transcripts.length}`);
  console.info(`[audio-local-stt-smoke] pipelineDetected=${stats.pipelineDetected}`);
  console.info(`[audio-local-stt-smoke] pipelineResponses=${stats.pipelineResponses}`);
  console.info(
    `[audio-local-stt-smoke] nativeErrors=${stats.nativeErrors.length} sttErrors=${stats.sttErrors.length} pipelineErrors=${stats.pipelineErrors.length}`,
  );
}

function isSuccessful(stats: LocalSttSmokeStats, options: LocalSttSmokeOptions): boolean {
  if (stats.sentChunks === 0) {
    console.error(`[audio-local-stt-smoke] failed: no ${options.source} audio chunks sent`);
    return false;
  }

  if (stats.sttErrors.length > 0) {
    console.error('[audio-local-stt-smoke] failed: local STT reported errors');
    return false;
  }

  if (options.requireTranscript && stats.transcripts.length === 0) {
    console.error('[audio-local-stt-smoke] failed: no transcripts received');
    return false;
  }

  if (options.requirePipeline && stats.pipelineResponses === 0) {
    console.error('[audio-local-stt-smoke] failed: no pipeline response produced');
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
        console.error('[audio-local-stt-smoke] timeout: ' + workerData.message);
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
  console.info(`Usage: npm run native:audio:local-stt-smoke -- [options]

Options:
  --source <microphone|system>  Audio source to send to Apple SpeechAnalyzer. Default: ${DEFAULT_SOURCE}
  --duration-ms <ms>            Capture duration. Default: ${DEFAULT_DURATION_MS}
  --target-bundle-id <id>       Target app for system audio. Default: ${DEFAULT_TARGET_APP_BUNDLE_ID}
  --sample-rate <hz>            Capture sample rate. Default: ${DEFAULT_SAMPLE_RATE}
  --start-timeout-ms <ms>       Kill the process if native start blocks. Default: ${DEFAULT_START_TIMEOUT_MS}
  --module-path <path>          Override audio_capture.node path
  --helper-path <path>          Override speech-analyzer-helper path
  --require-transcript          Fail when no transcript is received
  --require-pipeline            Fail when mock pipeline does not produce a response
  --help                        Show this help
`);
}

async function main(): Promise<void> {
  try {
    const options = parseOptions(process.argv.slice(2));
    const exitCode = await runLocalSttSmoke(options);
    process.exit(exitCode);
  } catch (error) {
    console.error('[audio-local-stt-smoke] failed', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

void main();
