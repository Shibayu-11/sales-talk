/**
 * Batch (file-mode) transcription using the Apple SpeechAnalyzer helper binary.
 * Per W3-C: local-first import transcription via SpeechAnalyzer file mode.
 *
 * The helper is spawned with a {type:'file', path, locale?} message and
 * emits transcript JSON events identical to realtime mode, then a
 * {type:'done'} event when transcription is complete.
 *
 * Reuses spawn/readline plumbing from apple-speech-analyzer.ts.
 */

import { existsSync } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AudioAsset, Transcript } from '@shared/types';
import { resolveSpeechAnalyzerHelperPath } from './apple-speech-analyzer';

interface BatchHelperTranscriptMessage {
  type: 'transcript';
  speaker: 'self' | 'counterpart';
  text: string;
  isFinal: boolean;
  startMs: number;
  endMs?: number;
}

interface BatchHelperErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

interface BatchHelperDoneMessage {
  type: 'done';
}

type BatchHelperMessage =
  | BatchHelperTranscriptMessage
  | BatchHelperErrorMessage
  | BatchHelperDoneMessage;

export interface AppleSpeechAnalyzerBatchTranscriberOptions {
  helperPath?: string | undefined;
  locale?: string | undefined;
  spawnProcess?: typeof spawn | undefined;
}

export class AppleSpeechAnalyzerBatchTranscriber {
  private readonly helperPath: string;
  private readonly locale: string;
  private readonly spawnProcess: typeof spawn;

  constructor(options: AppleSpeechAnalyzerBatchTranscriberOptions = {}) {
    this.helperPath = options.helperPath ?? resolveSpeechAnalyzerHelperPath();
    this.locale = options.locale ?? 'ja-JP';
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  isAvailable(): boolean {
    return existsSync(this.helperPath);
  }

  async transcribeFile(
    asset: AudioAsset,
    signal?: AbortSignal | undefined,
  ): Promise<Transcript[]> {
    if (!existsSync(this.helperPath)) {
      throw new Error(`Apple SpeechAnalyzer helper was not found: ${this.helperPath}`);
    }
    if (signal?.aborted) {
      throw createAbortError();
    }

    const child: ChildProcessWithoutNullStreams = this.spawnProcess(this.helperPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return new Promise<Transcript[]>((resolve, reject) => {
      const collectedTranscripts: Transcript[] = [];
      let settled = false;
      const abort = (): void => {
        if (!child.killed && child.exitCode === null) {
          child.kill('SIGTERM');
        }
        settle(createAbortError());
      };

      const settle = (err?: Error): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        stdoutReader.close();
        if (!child.killed && child.exitCode === null) {
          child.kill('SIGTERM');
        }
        if (err) {
          reject(err);
        } else {
          resolve(collectedTranscripts);
        }
      };

      const stdoutReader = createInterface({ input: child.stdout });
      signal?.addEventListener('abort', abort, { once: true });
      stdoutReader.on('line', (line: string) => {
        const msg = parseBatchHelperMessage(line);
        if (!msg) return;

        if (msg.type === 'error') {
          settle(new Error(`Apple SpeechAnalyzer batch error [${msg.code}]: ${msg.message}`));
          return;
        }
        if (msg.type === 'done') {
          settle();
          return;
        }
        // transcript message
        const text = msg.text.trim();
        if (!text) return;
        const transcript: Transcript = {
          speaker: 'counterpart',
          text,
          isFinal: true,
          startMs: msg.startMs,
          endMs: msg.endMs ?? msg.startMs + 1,
        };
        collectedTranscripts.push(transcript);
      });

      child.stderr.on('data', (data: Buffer) => {
        const message = data.toString('utf8').trim();
        if (message) {
          // Stderr is informational; only reject on fatal errors via the message protocol.
          // Non-fatal stderr lines are intentionally swallowed here.
        }
      });

      child.on('error', (err: Error) => {
        settle(err);
      });

      child.on('exit', (code, signal) => {
        if (!settled) {
          // Helper exited without sending {type:'done'} — treat as completion if code 0,
          // otherwise error.
          if (code === 0) {
            settle();
          } else {
            settle(
              new Error(
                `Apple SpeechAnalyzer helper exited unexpectedly: ${code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`}`,
              ),
            );
          }
        }
      });

      child.once('spawn', () => {
        // Send file-mode input message once the process is running.
        child.stdin.write(
          `${JSON.stringify({ type: 'file', path: asset.storedPath, locale: this.locale })}\n`,
        );
        child.stdin.end();
      });

      child.on('error', (err: Error) => {
        settle(err);
      });
    });
  }
}

function createAbortError(): Error {
  const error = new Error('STT transcription was aborted');
  error.name = 'AbortError';
  return error;
}

function parseBatchHelperMessage(line: string): BatchHelperMessage | null {
  try {
    const parsed = JSON.parse(line) as Partial<BatchHelperMessage>;
    if (
      parsed.type === 'error' &&
      typeof (parsed as BatchHelperErrorMessage).code === 'string' &&
      typeof (parsed as BatchHelperErrorMessage).message === 'string'
    ) {
      return parsed as BatchHelperErrorMessage;
    }
    if (parsed.type === 'done') {
      return parsed as BatchHelperDoneMessage;
    }
    if (
      parsed.type === 'transcript' &&
      ((parsed as BatchHelperTranscriptMessage).speaker === 'self' ||
        (parsed as BatchHelperTranscriptMessage).speaker === 'counterpart') &&
      typeof (parsed as BatchHelperTranscriptMessage).text === 'string' &&
      typeof (parsed as BatchHelperTranscriptMessage).startMs === 'number'
    ) {
      return parsed as BatchHelperTranscriptMessage;
    }
    return null;
  } catch {
    return null;
  }
}
