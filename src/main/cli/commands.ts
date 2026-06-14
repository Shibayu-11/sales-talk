/**
 * CLI command implementations.
 * All business logic is injected via deps so this module is testable without Electron.
 * Per PRD §29: never log transcript/PII through Pino in CLI mode;
 * structured results are printed to stdout for the invoking agent/shell.
 */

import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { ProductIdSchema } from '@shared/schemas';
import type {
  AudioAsset,
  AudioSttJob,
  MeetingMinute,
  MeetingSource,
  ProductId,
  RecordingConsent,
  Transcript,
  TranscriptSegment,
} from '@shared/types';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type CliOk<T> = { ok: true } & T;
export type CliErr = { ok: false; error: string; detail?: string | undefined };
export type CliResult<T> = CliOk<T> | CliErr;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const FilePathSchema = z.string().min(1);

export function parseProductId(raw: string | undefined): CliResult<{ productId: ProductId }> {
  if (raw === undefined) {
    return { ok: true, productId: 'real_estate' }; // default
  }
  const result = ProductIdSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      error: 'invalid_product',
      detail: `--product must be one of: real_estate, kenko_keiei, hojokin (got: ${raw})`,
    };
  }
  return { ok: true, productId: result.data };
}

export async function validateFilePath(raw: string | undefined): Promise<CliResult<{ filePath: string }>> {
  if (!raw) {
    return { ok: false, error: 'missing_file', detail: '--file <path> is required' };
  }
  const parsed = FilePathSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_file_path', detail: 'File path must be a non-empty string' };
  }
  try {
    await stat(parsed.data);
  } catch {
    return { ok: false, error: 'file_not_found', detail: `File not found: ${parsed.data}` };
  }
  return { ok: true, filePath: parsed.data };
}

// ---------------------------------------------------------------------------
// Dependency interfaces (injected so each command is unit-testable)
// ---------------------------------------------------------------------------

export interface RecordDeps {
  checkPermissions(): { screen: boolean; microphone: boolean };
  startNativeCapture(): Promise<void>;
  stopNativeCapture(): Promise<void>;
  createCall(input: {
    productId: ProductId;
    consent: RecordingConsent;
  }): Promise<{ id: string }>;
  endCall(callId: string): Promise<void>;
  getActiveCallId(): string | null;
}

export interface TranscribeDeps {
  importAudioFile(input: { callId: string; filePath: string }): Promise<AudioAsset>;
  createCall(input: {
    productId: ProductId;
    consent: RecordingConsent;
  }): Promise<{ id: string }>;
  endCall(callId: string): Promise<void>;
  createSttJob(audioAssetId: string, callId: string, productId: ProductId): Promise<AudioSttJob>;
  runSttJob(jobId: string): Promise<AudioSttJob>;
  listTranscripts(callId: string): Promise<TranscriptSegment[]>;
}

export interface MinutesDeps {
  listCalls(): Promise<Array<{ id: string; productId: ProductId; source: MeetingSource }>>;
  listTranscripts(callId: string): Promise<TranscriptSegment[]>;
  generateMinutes(input: {
    callId: string;
    productId: ProductId;
    source: MeetingSource;
    transcripts: Transcript[];
  }): Promise<MeetingMinute>;
  setLatestMinute(minute: MeetingMinute): Promise<MeetingMinute>;
  getActiveCallId(): string | null;
}

// ---------------------------------------------------------------------------
// Default recording consent for CLI sessions
// ---------------------------------------------------------------------------

function cliConsent(): RecordingConsent {
  return {
    status: 'granted',
    method: 'digital',
    capturedAt: new Date().toISOString(),
    noticeVersion: 'cli-v1',
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** `salestalk record start [--product <id>]` */
export async function cmdRecordStart(
  args: { productId?: string | undefined },
  deps: RecordDeps,
): Promise<CliResult<{ callId: string; productId: ProductId }>> {
  const productResult = parseProductId(args.productId);
  if (!productResult.ok) return productResult;
  const { productId } = productResult;

  const perms = deps.checkPermissions();
  if (!perms.screen || !perms.microphone) {
    const missing = [!perms.screen && 'screen', !perms.microphone && 'microphone']
      .filter(Boolean)
      .join(', ');
    return {
      ok: false,
      error: 'permission_required',
      detail: `Missing permissions: ${missing}. Grant them in System Settings > Privacy.`,
    };
  }

  let call: { id: string };
  try {
    call = await deps.createCall({ productId, consent: cliConsent() });
  } catch (err) {
    return {
      ok: false,
      error: 'call_create_failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    await deps.startNativeCapture();
  } catch (err) {
    // Best-effort: call was created but native capture failed.
    return {
      ok: false,
      error: 'capture_start_failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  return { ok: true, callId: call.id, productId };
}

/** `salestalk record stop` */
export async function cmdRecordStop(
  deps: RecordDeps,
): Promise<CliResult<{ callId: string | null }>> {
  const callId = deps.getActiveCallId();

  try {
    await deps.stopNativeCapture();
  } catch (err) {
    return {
      ok: false,
      error: 'capture_stop_failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (callId) {
    try {
      await deps.endCall(callId);
    } catch {
      // Non-fatal: capture is stopped; log entry may be incomplete.
    }
  }

  return { ok: true, callId };
}

/** `salestalk transcribe --file <path> [--product <id>]` */
export async function cmdTranscribe(
  args: { filePath?: string | undefined; productId?: string | undefined },
  deps: TranscribeDeps,
): Promise<
  CliResult<{
    callId: string;
    jobId: string;
    jobStatus: AudioSttJob['status'];
    transcriptCount: number;
    transcripts: Array<{ speaker: string; text: string; isFinal: boolean; startMs: number }>;
  }>
> {
  const fileResult = await validateFilePath(args.filePath);
  if (!fileResult.ok) return fileResult;

  const productResult = parseProductId(args.productId);
  if (!productResult.ok) return productResult;
  const { productId } = productResult;

  let call: { id: string };
  try {
    call = await deps.createCall({ productId, consent: cliConsent() });
    await deps.endCall(call.id);
  } catch (err) {
    return {
      ok: false,
      error: 'call_create_failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  let asset: AudioAsset;
  try {
    asset = await deps.importAudioFile({ callId: call.id, filePath: fileResult.filePath });
  } catch (err) {
    return {
      ok: false,
      error: 'import_failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  let sttJob: AudioSttJob;
  try {
    sttJob = await deps.createSttJob(asset.id, call.id, productId);
    sttJob = await deps.runSttJob(sttJob.id);
  } catch (err) {
    return {
      ok: false,
      error: 'stt_job_failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const segments = await deps.listTranscripts(call.id);
  // Transcripts are printed to stdout for the invoking agent.
  // They must NOT be written to Pino logs (PII risk per PRD §29).
  const transcripts = segments.map((s) => ({
    speaker: s.speaker,
    text: s.text,
    isFinal: s.isFinal,
    startMs: s.startMs,
  }));

  return {
    ok: true,
    callId: call.id,
    jobId: sttJob.id,
    jobStatus: sttJob.status,
    transcriptCount: segments.length,
    transcripts,
  };
}

/** `salestalk minutes [--call-id <id>] [--product <id>]` */
export async function cmdMinutes(
  args: { callId?: string | undefined; productId?: string | undefined },
  deps: MinutesDeps,
): Promise<CliResult<{ minute: MeetingMinute }>> {
  const productResult = parseProductId(args.productId);
  if (!productResult.ok) return productResult;

  // Resolve callId: explicit arg → active call → most recent call
  let resolvedCallId: string;
  let resolvedProductId: ProductId = productResult.productId;
  let resolvedSource: MeetingSource = 'manual_transcript';

  if (args.callId) {
    resolvedCallId = args.callId;
  } else {
    const active = deps.getActiveCallId();
    if (active) {
      resolvedCallId = active;
    } else {
      const calls = await deps.listCalls();
      if (calls.length === 0) {
        return { ok: false, error: 'no_calls', detail: 'No calls found. Run `salestalk transcribe` or `salestalk record start` first.' };
      }
      const latest = calls[calls.length - 1];
      if (!latest) {
        return { ok: false, error: 'no_calls', detail: 'No calls found.' };
      }
      resolvedCallId = latest.id;
      resolvedProductId = latest.productId;
      resolvedSource = latest.source;
    }
  }

  // If --product was explicitly set (not the default), use that; else keep from call.
  if (args.productId !== undefined) {
    resolvedProductId = productResult.productId;
  }

  let minute: MeetingMinute;
  try {
    const segments = await deps.listTranscripts(resolvedCallId);
    const transcripts: Transcript[] = segments.map((s) =>
      s.isFinal
        ? { speaker: s.speaker, text: s.text, isFinal: true, startMs: s.startMs, endMs: s.endMs ?? s.startMs }
        : { speaker: s.speaker, text: s.text, isFinal: false, startMs: s.startMs },
    );
    minute = await deps.generateMinutes({
      callId: resolvedCallId,
      productId: resolvedProductId,
      source: resolvedSource,
      transcripts,
    });
    await deps.setLatestMinute(minute);
  } catch (err) {
    return {
      ok: false,
      error: 'minutes_generation_failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  return { ok: true, minute };
}

// ---------------------------------------------------------------------------
// Arg parser (no external deps — uses raw process.argv slice)
// ---------------------------------------------------------------------------

export interface ParsedCliArgs {
  subcommand: 'record' | 'transcribe' | 'minutes' | 'help';
  subAction?: 'start' | 'stop' | undefined;
  product?: string | undefined;
  file?: string | undefined;
  callId?: string | undefined;
}

export type ParseCliResult = CliResult<ParsedCliArgs>;

/**
 * Minimal argv parser. Input is the slice after the `--cli` marker,
 * e.g. `['record', 'start', '--product', 'real_estate']`.
 */
export function parseCliArgs(argv: string[]): ParseCliResult {
  const args = argv.filter((a) => a !== '--cli');

  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    return { ok: true, subcommand: 'help' };
  }

  if (sub === 'record') {
    const action = args[1];
    if (action !== 'start' && action !== 'stop') {
      return {
        ok: false,
        error: 'unknown_subcommand',
        detail: `Expected: record start | record stop (got: record ${action ?? ''})`,
      };
    }
    return {
      ok: true,
      subcommand: 'record',
      subAction: action,
      product: extractFlag(args, '--product'),
    };
  }

  if (sub === 'transcribe') {
    return {
      ok: true,
      subcommand: 'transcribe',
      file: extractFlag(args, '--file'),
      product: extractFlag(args, '--product'),
    };
  }

  if (sub === 'minutes') {
    return {
      ok: true,
      subcommand: 'minutes',
      callId: extractFlag(args, '--call-id'),
      product: extractFlag(args, '--product'),
    };
  }

  return {
    ok: false,
    error: 'unknown_subcommand',
    detail: `Unknown subcommand: ${sub}. Run --help for usage.`,
  };
}

function extractFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

export const CLI_HELP = `
salestalk CLI — sales-talk Electron app headless interface

USAGE
  salestalk <subcommand> [options]

SUBCOMMANDS
  record start [--product <id>]      Start a recording session
  record stop                        Stop the current recording session
  transcribe --file <path>           Transcribe an audio file (local-first STT)
             [--product <id>]
  minutes [--call-id <id>]           Generate meeting minutes for a call
          [--product <id>]
  --help                             Show this help

PRODUCT IDs
  real_estate   不動産
  kenko_keiei   健康経営
  hojokin       補助金・助成金

OUTPUT
  All subcommands print a single JSON object: {ok:true,...} or {ok:false,error,...}

EXAMPLES
  salestalk record start --product real_estate
  salestalk record stop
  salestalk transcribe --file /path/to/meeting.m4a --product kenko_keiei
  salestalk minutes --call-id <uuid>

URL SCHEME (macOS Shortcuts / Spotlight)
  salestalk://record/start?product=real_estate
  salestalk://record/stop
`.trim();

// Re-export randomUUID so commands.ts has no Electron dependency
export { randomUUID };
