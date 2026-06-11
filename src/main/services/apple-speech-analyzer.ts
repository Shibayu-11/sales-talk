import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import type { AudioChunk, Transcript } from '@shared/types';
import type { STTProvider } from './stt';

const HELPER_RESOURCE_PATH = join('native', 'audio-capture', 'speech-analyzer-helper');
const HELPER_DEV_PATH = join(
  'src',
  'native',
  'audio-capture',
  '.build',
  'debug',
  'speech-analyzer-helper',
);
const HELPER_RELEASE_PATH = join(
  'src',
  'native',
  'audio-capture',
  '.build',
  'release',
  'speech-analyzer-helper',
);

type ProcessWithElectronResources = NodeJS.Process & { resourcesPath?: string };

interface HelperTranscriptMessage {
  type: 'transcript';
  speaker: 'self' | 'counterpart';
  text: string;
  isFinal: boolean;
  startMs: number;
  endMs?: number;
}

interface HelperErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

interface HelperReadyMessage {
  type: 'ready';
  sampleRate: number;
}

type HelperMessage = HelperTranscriptMessage | HelperErrorMessage | HelperReadyMessage;

export interface AppleSpeechAnalyzerSTTProviderOptions {
  helperPath?: string | undefined;
  locale?: string | undefined;
  sampleRate?: number | undefined;
  spawnProcess?: typeof spawn | undefined;
}

export class AppleSpeechAnalyzerSTTProvider implements STTProvider {
  private process: ChildProcessWithoutNullStreams | null = null;
  private stdoutReader: Interface | null = null;
  private transcriptHandler: ((transcript: Transcript) => void) | null = null;
  private lastError: Error | null = null;
  private readyHandler: (() => void) | null = null;
  private timelineOriginMs: number | null = null;
  private nextAudioStartMs = 0;
  private lastEmittedFinalText = '';
  private readonly helperPath: string;
  private readonly sampleRate: number;
  private readonly spawnProcess: typeof spawn;

  constructor(options: AppleSpeechAnalyzerSTTProviderOptions = {}) {
    this.helperPath = options.helperPath ?? resolveSpeechAnalyzerHelperPath();
    this.sampleRate = options.sampleRate ?? 16_000;
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  async connect(): Promise<void> {
    if (this.process) {
      return;
    }
    if (!existsSync(this.helperPath)) {
      throw new Error(`Apple SpeechAnalyzer helper was not found: ${this.helperPath}`);
    }
    this.lastError = null;
    this.timelineOriginMs = null;
    this.nextAudioStartMs = 0;
    this.lastEmittedFinalText = '';

    const child = this.spawnProcess(this.helperPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process = child;

    this.stdoutReader = createInterface({ input: child.stdout });
    this.stdoutReader.on('line', (line) => {
      this.handleHelperLine(line);
    });

    child.stderr.on('data', (data: Buffer) => {
      const message = data.toString('utf8').trim();
      if (message) {
        this.handleHelperError(new Error(message));
      }
    });
    child.on('exit', (code, signal) => {
      if (this.process === child) {
        this.lastError ??= new Error(
          `Apple SpeechAnalyzer helper exited: ${code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`}`,
        );
        this.process = null;
      }
    });

    await new Promise<void>((resolve, reject) => {
      const readyTimeout = setTimeout(() => {
        cleanup();
        reject(new Error('Apple SpeechAnalyzer helper did not become ready within 15000ms'));
      }, 15_000);
      const cleanup = (): void => {
        clearTimeout(readyTimeout);
        this.readyHandler = null;
        child.off('spawn', handleSpawn);
        child.off('error', handleError);
        child.off('exit', handleExit);
      };
      const handleSpawn = (): void => {
        this.readyHandler = () => {
          cleanup();
          resolve();
        };
      };
      const handleError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const handleExit = (code: number | null): void => {
        cleanup();
        reject(new Error(`Apple SpeechAnalyzer helper exited before start: ${code ?? 'signal'}`));
      };

      child.once('spawn', handleSpawn);
      child.once('error', handleError);
      child.once('exit', handleExit);
    });
  }

  async disconnect(): Promise<void> {
    const child = this.process;
    this.process = null;
    this.stdoutReader?.close();
    this.stdoutReader = null;
    if (!child) {
      return;
    }

    if (!child.killed && child.exitCode === null) {
      child.stdin.write(`${JSON.stringify({ type: 'stop' })}\n`);
      child.stdin.end();
      await waitForExit(child, 5_000);
      if (!child.killed && child.exitCode === null) {
        child.kill('SIGTERM');
      }
    }
  }

  async sendAudio(chunk: AudioChunk): Promise<void> {
    if (this.lastError) {
      throw this.lastError;
    }
    if (!this.process || this.process.stdin.destroyed) {
      throw new Error('Apple SpeechAnalyzer helper is not connected');
    }

    const startMs = this.normalizeAudioStartMs(chunk);
    this.process.stdin.write(
      `${JSON.stringify({
        type: 'audio',
        data: chunk.data,
        startMs,
        sampleRate: this.sampleRate,
      })}\n`,
    );
  }

  setTranscriptHandler(handler: (transcript: Transcript) => void): void {
    this.transcriptHandler = handler;
  }

  private handleHelperLine(line: string): void {
    const message = parseHelperMessage(line);
    if (!message) {
      return;
    }
    if (message.type === 'error') {
      this.handleHelperError(new Error(`${message.code}: ${message.message}`));
      return;
    }
    if (message.type === 'ready') {
      this.readyHandler?.();
      return;
    }
    if (this.shouldSuppressTranscript(message)) {
      return;
    }

    const transcript: Transcript = message.isFinal
      ? {
          speaker: message.speaker,
          text: message.text,
          isFinal: true,
          startMs: message.startMs,
          endMs: message.endMs ?? message.startMs + 1,
        }
      : {
          speaker: message.speaker,
          text: message.text,
          isFinal: false,
          startMs: message.startMs,
        };
    this.transcriptHandler?.(transcript);
  }

  private handleHelperError(error: Error): void {
    this.lastError = error;
    if (this.process && this.process.exitCode === null) {
      this.process.kill('SIGTERM');
    }
  }

  private normalizeAudioStartMs(chunk: AudioChunk): number {
    this.timelineOriginMs ??= chunk.startMs;
    const relativeStartMs = Math.max(0, chunk.startMs - this.timelineOriginMs);
    const startMs = Math.max(relativeStartMs, this.nextAudioStartMs);
    this.nextAudioStartMs = startMs + Math.max(1, chunk.durationMs);
    return startMs;
  }

  private shouldSuppressTranscript(message: HelperTranscriptMessage): boolean {
    const text = message.text.trim();
    if (!text) {
      return true;
    }
    if (!message.isFinal) {
      return false;
    }
    if (text === this.lastEmittedFinalText) {
      return true;
    }
    if (text.startsWith(this.lastEmittedFinalText) && text.length - this.lastEmittedFinalText.length < 4) {
      return true;
    }
    this.lastEmittedFinalText = text;
    return false;
  }
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.killed) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off('exit', handleExit);
    };
    const handleExit = (): void => {
      cleanup();
      resolve();
    };
    child.once('exit', handleExit);
  });
}

export async function createAppleSpeechAnalyzerSTTProvider(): Promise<AppleSpeechAnalyzerSTTProvider | null> {
  const helperPath = resolveSpeechAnalyzerHelperPath();
  if (!existsSync(helperPath)) {
    return null;
  }

  return new AppleSpeechAnalyzerSTTProvider({ helperPath });
}

export function resolveSpeechAnalyzerHelperPath(): string {
  if (process.env.SALES_TALK_SPEECH_ANALYZER_HELPER) {
    return process.env.SALES_TALK_SPEECH_ANALYZER_HELPER;
  }

  const resourcesPath = getElectronResourcesPath();
  const candidatePaths = resourcesPath ? [join(resourcesPath, HELPER_RESOURCE_PATH)] : [];
  candidatePaths.push(join(process.cwd(), HELPER_RELEASE_PATH));
  candidatePaths.push(join(process.cwd(), HELPER_DEV_PATH));
  return candidatePaths.find((candidatePath) => existsSync(candidatePath)) ?? candidatePaths[0] ?? join(process.cwd(), HELPER_DEV_PATH);
}

function getElectronResourcesPath(): string | null {
  const resourcesPath = (process as ProcessWithElectronResources).resourcesPath;
  return typeof resourcesPath === 'string' && resourcesPath.length > 0 ? resourcesPath : null;
}

function parseHelperMessage(line: string): HelperMessage | null {
  try {
    const parsed = JSON.parse(line) as Partial<HelperMessage>;
    if (parsed.type === 'error' && typeof parsed.code === 'string' && typeof parsed.message === 'string') {
      return parsed as HelperErrorMessage;
    }
    if (parsed.type === 'ready' && typeof parsed.sampleRate === 'number') {
      return parsed as HelperReadyMessage;
    }
    if (
      parsed.type === 'transcript' &&
      (parsed.speaker === 'self' || parsed.speaker === 'counterpart') &&
      typeof parsed.text === 'string' &&
      typeof parsed.isFinal === 'boolean' &&
      typeof parsed.startMs === 'number'
    ) {
      return parsed as HelperTranscriptMessage;
    }
    return null;
  } catch {
    return null;
  }
}
