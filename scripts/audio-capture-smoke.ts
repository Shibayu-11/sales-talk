/* eslint-disable no-console */
import { Worker } from 'node:worker_threads';
import type { NativeAudioCaptureModule, NativeAudioChunk, NativeCaptureError } from '../src/main/audio/native-audio-capture';
import {
  getNativeAudioCaptureModuleStatus,
  loadNativeAudioCaptureModule,
  resolveNativeAudioCaptureModulePath,
} from '../src/main/audio/native-module-loader';

interface SmokeOptions {
  durationMs: number;
  modulePath: string;
  requireMicrophone: boolean;
  requireSystem: boolean;
  sampleRate: number;
  startTimeoutMs: number;
  targetAppBundleId: string;
}

interface SourceStats {
  chunks: number;
  bytes: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  sampleRates: Set<number>;
}

interface SmokeStats {
  microphone: SourceStats;
  system: SourceStats;
  errors: NativeCaptureError[];
}

const DEFAULT_DURATION_MS = 5_000;
const DEFAULT_SAMPLE_RATE = 16_000;
const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_TARGET_APP_BUNDLE_ID = 'us.zoom.xos';

function parseOptions(argv: string[]): SmokeOptions {
  const options: SmokeOptions = {
    durationMs: DEFAULT_DURATION_MS,
    modulePath: resolveNativeAudioCaptureModulePath(),
    requireMicrophone: false,
    requireSystem: false,
    sampleRate: DEFAULT_SAMPLE_RATE,
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
      case '--duration-ms':
        options.durationMs = parsePositiveInteger(nextValue, '--duration-ms');
        if (consumedNext) index += 1;
        break;
      case '--module-path':
        options.modulePath = parseNonEmptyString(nextValue, '--module-path');
        if (consumedNext) index += 1;
        break;
      case '--sample-rate':
        options.sampleRate = parsePositiveInteger(nextValue, '--sample-rate');
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
      case '--require-microphone':
        options.requireMicrophone = true;
        break;
      case '--require-system':
        options.requireSystem = true;
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

function createStats(): SmokeStats {
  return {
    microphone: createSourceStats(),
    system: createSourceStats(),
    errors: [],
  };
}

function createSourceStats(): SourceStats {
  return {
    chunks: 0,
    bytes: 0,
    firstTimestamp: null,
    lastTimestamp: null,
    sampleRates: new Set<number>(),
  };
}

function updateStats(stats: SmokeStats, chunk: NativeAudioChunk): void {
  const sourceStats = stats[chunk.source];
  const byteLength = getAudioByteLength(chunk.data);
  sourceStats.chunks += 1;
  sourceStats.bytes += byteLength;
  sourceStats.firstTimestamp = sourceStats.firstTimestamp ?? chunk.timestamp;
  sourceStats.lastTimestamp = chunk.timestamp;
  sourceStats.sampleRates.add(chunk.sampleRate);
}

function getAudioByteLength(data: Buffer | Uint8Array | string): number {
  if (typeof data === 'string') {
    return Buffer.byteLength(data, 'base64');
  }
  return data.byteLength;
}

async function runSmokeTest(options: SmokeOptions): Promise<number> {
  const moduleStatus = getNativeAudioCaptureModuleStatus(options.modulePath);
  console.info('[audio-smoke] module', moduleStatus);

  const nativeModule = loadNativeAudioCaptureModule(options.modulePath);
  if (!nativeModule) {
    console.error(`[audio-smoke] native module not found: ${options.modulePath}`);
    return 1;
  }

  const stats = createStats();
  registerCallbacks(nativeModule, stats);

  let sessionId: string | null = null;
  try {
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
      `[audio-smoke] started session=${session.sessionId} durationMs=${options.durationMs} target=${options.targetAppBundleId}`,
    );

    await wait(options.durationMs);
  } catch (error) {
    console.error('[audio-smoke] start failed', error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await stopCapture(nativeModule, sessionId);
  }

  printSummary(stats);
  return isSmokeTestSuccessful(stats, options) ? 0 : 1;
}

function registerCallbacks(nativeModule: NativeAudioCaptureModule, stats: SmokeStats): void {
  nativeModule.onAudioChunk((chunk) => {
    updateStats(stats, chunk);
  });
  nativeModule.onError((error) => {
    stats.errors.push(error);
    console.warn(`[audio-smoke] native error code=${error.code} message=${error.message}`);
  });
}

async function stopCapture(nativeModule: NativeAudioCaptureModule, sessionId: string | null): Promise<void> {
  if (!sessionId) {
    return;
  }

  try {
    await nativeModule.stopCapture(sessionId);
  } catch (error) {
    console.warn('[audio-smoke] stop failed', error instanceof Error ? error.message : String(error));
  }
}

function isSmokeTestSuccessful(stats: SmokeStats, options: SmokeOptions): boolean {
  if (stats.microphone.chunks + stats.system.chunks === 0) {
    console.error('[audio-smoke] failed: no audio chunks received');
    return false;
  }

  if (options.requireMicrophone && stats.microphone.chunks === 0) {
    console.error('[audio-smoke] failed: no microphone chunks received');
    return false;
  }

  if (options.requireSystem && stats.system.chunks === 0) {
    console.error('[audio-smoke] failed: no system chunks received');
    return false;
  }

  return true;
}

function printSummary(stats: SmokeStats): void {
  console.info('[audio-smoke] summary');
  printSourceSummary('microphone', stats.microphone);
  printSourceSummary('system', stats.system);
  console.info(`[audio-smoke] errors=${stats.errors.length}`);
}

function printSourceSummary(source: 'microphone' | 'system', stats: SourceStats): void {
  const sampleRates = Array.from(stats.sampleRates).sort((left, right) => left - right).join(',') || '-';
  console.info(
    `[audio-smoke] ${source} chunks=${stats.chunks} bytes=${stats.bytes} sampleRates=${sampleRates}`,
  );
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
        console.error('[audio-smoke] timeout: ' + workerData.message);
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
  console.info(`Usage: npm run native:audio:smoke -- [options]

Options:
  --duration-ms <ms>         Capture duration. Default: ${DEFAULT_DURATION_MS}
  --target-bundle-id <id>    Target app for system audio. Default: ${DEFAULT_TARGET_APP_BUNDLE_ID}
  --sample-rate <hz>         Capture sample rate. Default: ${DEFAULT_SAMPLE_RATE}
  --start-timeout-ms <ms>    Kill the process if native start blocks. Default: ${DEFAULT_START_TIMEOUT_MS}
  --module-path <path>       Override audio_capture.node path
  --require-microphone       Fail when microphone chunks are absent
  --require-system           Fail when system chunks are absent
  --help                     Show this help
`);
}

async function main(): Promise<void> {
  try {
    const options = parseOptions(process.argv.slice(2));
    const exitCode = await runSmokeTest(options);
    process.exit(exitCode);
  } catch (error) {
    console.error('[audio-smoke] failed', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

void main();
