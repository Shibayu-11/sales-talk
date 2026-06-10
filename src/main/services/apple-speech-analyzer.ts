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

type HelperMessage = HelperTranscriptMessage | HelperErrorMessage;

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

    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        child.off('spawn', handleSpawn);
        child.off('error', handleError);
        child.off('exit', handleExit);
      };
      const handleSpawn = (): void => {
        cleanup();
        resolve();
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
      child.kill('SIGTERM');
    }
  }

  async sendAudio(chunk: AudioChunk): Promise<void> {
    if (this.lastError) {
      throw this.lastError;
    }
    if (!this.process || this.process.stdin.destroyed) {
      throw new Error('Apple SpeechAnalyzer helper is not connected');
    }

    this.process.stdin.write(
      `${JSON.stringify({
        type: 'audio',
        data: chunk.data,
        startMs: chunk.startMs,
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
