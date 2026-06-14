/**
 * Unit tests for CLI commands (src/main/cli/commands.ts).
 * No Electron, no native modules — all services are injected mocks.
 */

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  parseCliArgs,
  parseProductId,
  validateFilePath,
  cmdRecordStart,
  cmdRecordStop,
  cmdTranscribe,
  cmdMinutes,
  CLI_HELP,
} from '../../src/main/cli/commands';
import type {
  RecordDeps,
  TranscribeDeps,
  MinutesDeps,
} from '../../src/main/cli/commands';
import type {
  AudioAsset,
  AudioSttJob,
  MeetingMinute,
  TranscriptSegment,
} from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAudioAsset(overrides?: Partial<AudioAsset>): AudioAsset {
  return {
    id: 'asset-1',
    callId: 'call-1',
    fileName: 'test.m4a',
    originalPath: '/tmp/test.m4a',
    storedPath: '/tmp/stored/test.m4a',
    mimeType: 'audio/m4a',
    sizeBytes: 1024,
    createdAt: '2026-06-14T00:00:00.000Z',
    ...overrides,
  };
}

function makeSttJob(overrides?: Partial<AudioSttJob>): AudioSttJob {
  return {
    id: 'job-1',
    callId: 'call-1',
    audioAssetId: 'asset-1',
    provider: 'apple_speech_analyzer',
    status: 'completed',
    errorMessage: null,
    createdAt: '2026-06-14T00:00:00.000Z',
    updatedAt: '2026-06-14T00:00:00.000Z',
    ...overrides,
  };
}

function makeMinute(overrides?: Partial<MeetingMinute>): MeetingMinute {
  return {
    id: 'minute-1',
    callId: 'call-1',
    source: 'uploaded_audio',
    productId: 'real_estate',
    summary: 'テスト商談の概要',
    agreed: [],
    pending: [],
    decisions: [],
    numbers: [],
    complianceFindings: [],
    generatedAt: '2026-06-14T00:00:00.000Z',
    ...overrides,
  };
}

function makeTranscriptSegment(overrides?: Partial<TranscriptSegment>): TranscriptSegment {
  return {
    id: 'seg-1',
    callId: 'call-1',
    speaker: 'counterpart',
    text: 'テスト発話',
    isFinal: true,
    startMs: 0,
    endMs: 1000,
    createdAt: '2026-06-14T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseCliArgs
// ---------------------------------------------------------------------------

describe('parseCliArgs', () => {
  it('returns help for empty args', () => {
    expect(parseCliArgs([])).toMatchObject({ ok: true, subcommand: 'help' });
  });

  it('returns help for --help flag', () => {
    expect(parseCliArgs(['--help'])).toMatchObject({ ok: true, subcommand: 'help' });
  });

  it('returns help for help subcommand', () => {
    expect(parseCliArgs(['help'])).toMatchObject({ ok: true, subcommand: 'help' });
  });

  it('parses record start', () => {
    expect(parseCliArgs(['record', 'start'])).toMatchObject({
      ok: true,
      subcommand: 'record',
      subAction: 'start',
    });
  });

  it('parses record start with product', () => {
    expect(parseCliArgs(['record', 'start', '--product', 'kenko_keiei'])).toMatchObject({
      ok: true,
      subcommand: 'record',
      subAction: 'start',
      product: 'kenko_keiei',
    });
  });

  it('parses record stop', () => {
    expect(parseCliArgs(['record', 'stop'])).toMatchObject({
      ok: true,
      subcommand: 'record',
      subAction: 'stop',
    });
  });

  it('returns error for record with unknown action', () => {
    const result = parseCliArgs(['record', 'pause']);
    expect(result).toMatchObject({ ok: false, error: 'unknown_subcommand' });
  });

  it('parses transcribe with file', () => {
    expect(parseCliArgs(['transcribe', '--file', '/tmp/test.m4a'])).toMatchObject({
      ok: true,
      subcommand: 'transcribe',
      file: '/tmp/test.m4a',
    });
  });

  it('parses transcribe with file and product', () => {
    expect(
      parseCliArgs(['transcribe', '--file', '/tmp/test.m4a', '--product', 'hojokin']),
    ).toMatchObject({
      ok: true,
      subcommand: 'transcribe',
      file: '/tmp/test.m4a',
      product: 'hojokin',
    });
  });

  it('parses minutes with call-id', () => {
    expect(parseCliArgs(['minutes', '--call-id', 'abc-123'])).toMatchObject({
      ok: true,
      subcommand: 'minutes',
      callId: 'abc-123',
    });
  });

  it('returns error for unknown subcommand', () => {
    const result = parseCliArgs(['foobar']);
    expect(result).toMatchObject({ ok: false, error: 'unknown_subcommand' });
  });

  it('strips --cli marker before parsing', () => {
    expect(parseCliArgs(['--cli', 'record', 'stop'])).toMatchObject({
      ok: true,
      subcommand: 'record',
      subAction: 'stop',
    });
  });
});

// ---------------------------------------------------------------------------
// parseProductId
// ---------------------------------------------------------------------------

describe('parseProductId', () => {
  it('defaults to real_estate when undefined', () => {
    expect(parseProductId(undefined)).toMatchObject({ ok: true, productId: 'real_estate' });
  });

  it('accepts valid product ids', () => {
    expect(parseProductId('real_estate')).toMatchObject({ ok: true, productId: 'real_estate' });
    expect(parseProductId('kenko_keiei')).toMatchObject({ ok: true, productId: 'kenko_keiei' });
    expect(parseProductId('hojokin')).toMatchObject({ ok: true, productId: 'hojokin' });
  });

  it('rejects invalid product id', () => {
    expect(parseProductId('unknown')).toMatchObject({ ok: false, error: 'invalid_product' });
  });
});

// ---------------------------------------------------------------------------
// validateFilePath
// ---------------------------------------------------------------------------

describe('validateFilePath', () => {
  it('returns error when path is undefined', async () => {
    const result = await validateFilePath(undefined);
    expect(result).toMatchObject({ ok: false, error: 'missing_file' });
  });

  it('returns error when file does not exist', async () => {
    const result = await validateFilePath('/nonexistent/path/audio.m4a');
    expect(result).toMatchObject({ ok: false, error: 'file_not_found' });
  });

  it('returns ok when file exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'salestalk-cli-test-'));
    const filePath = join(dir, 'test.m4a');
    try {
      await writeFile(filePath, Buffer.alloc(16));
      const result = await validateFilePath(filePath);
      expect(result).toMatchObject({ ok: true, filePath });
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// cmdRecordStart
// ---------------------------------------------------------------------------

describe('cmdRecordStart', () => {
  function makeRecordDeps(overrides?: Partial<RecordDeps>): RecordDeps {
    return {
      checkPermissions: () => ({ screen: true, microphone: true }),
      startNativeCapture: vi.fn(async () => undefined),
      stopNativeCapture: vi.fn(async () => undefined),
      createCall: vi.fn(async () => ({ id: 'call-new-1' })),
      endCall: vi.fn(async () => undefined),
      getActiveCallId: () => null,
      ...overrides,
    };
  }

  it('returns {ok:true, callId, productId} on success', async () => {
    const deps = makeRecordDeps();
    const result = await cmdRecordStart({ productId: 'real_estate' }, deps);
    expect(result).toMatchObject({ ok: true, callId: 'call-new-1', productId: 'real_estate' });
    expect(deps.startNativeCapture).toHaveBeenCalled();
    expect(deps.createCall).toHaveBeenCalled();
  });

  it('defaults to real_estate when product omitted', async () => {
    const deps = makeRecordDeps();
    const result = await cmdRecordStart({}, deps);
    expect(result).toMatchObject({ ok: true, productId: 'real_estate' });
  });

  it('returns {ok:false, error:permission_required} when screen missing', async () => {
    const deps = makeRecordDeps({ checkPermissions: () => ({ screen: false, microphone: true }) });
    const result = await cmdRecordStart({}, deps);
    expect(result).toMatchObject({ ok: false, error: 'permission_required' });
    expect(deps.startNativeCapture).not.toHaveBeenCalled();
  });

  it('returns {ok:false, error:permission_required} when mic missing', async () => {
    const deps = makeRecordDeps({ checkPermissions: () => ({ screen: true, microphone: false }) });
    const result = await cmdRecordStart({}, deps);
    expect(result).toMatchObject({ ok: false, error: 'permission_required' });
  });

  it('returns {ok:false, error:invalid_product} for bad product', async () => {
    const deps = makeRecordDeps();
    const result = await cmdRecordStart({ productId: 'bad_product' }, deps);
    expect(result).toMatchObject({ ok: false, error: 'invalid_product' });
    expect(deps.createCall).not.toHaveBeenCalled();
  });

  it('returns {ok:false, error:capture_start_failed} when native capture throws', async () => {
    const deps = makeRecordDeps({
      startNativeCapture: vi.fn(async () => { throw new Error('module unavailable'); }),
    });
    const result = await cmdRecordStart({ productId: 'hojokin' }, deps);
    expect(result).toMatchObject({ ok: false, error: 'capture_start_failed' });
  });

  it('returns {ok:false, error:call_create_failed} when createCall throws', async () => {
    const deps = makeRecordDeps({
      createCall: vi.fn(async () => { throw new Error('db error'); }),
    });
    const result = await cmdRecordStart({}, deps);
    expect(result).toMatchObject({ ok: false, error: 'call_create_failed' });
    expect(deps.startNativeCapture).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cmdRecordStop
// ---------------------------------------------------------------------------

describe('cmdRecordStop', () => {
  function makeRecordDeps(overrides?: Partial<RecordDeps>): RecordDeps {
    return {
      checkPermissions: () => ({ screen: true, microphone: true }),
      startNativeCapture: vi.fn(async () => undefined),
      stopNativeCapture: vi.fn(async () => undefined),
      createCall: vi.fn(async () => ({ id: '' })),
      endCall: vi.fn(async () => undefined),
      getActiveCallId: () => 'call-active-1',
      ...overrides,
    };
  }

  it('returns {ok:true, callId} on success', async () => {
    const deps = makeRecordDeps();
    const result = await cmdRecordStop(deps);
    expect(result).toMatchObject({ ok: true, callId: 'call-active-1' });
    expect(deps.stopNativeCapture).toHaveBeenCalled();
    expect(deps.endCall).toHaveBeenCalledWith('call-active-1');
  });

  it('returns {ok:true, callId:null} when no active call', async () => {
    const deps = makeRecordDeps({ getActiveCallId: () => null });
    const result = await cmdRecordStop(deps);
    expect(result).toMatchObject({ ok: true, callId: null });
  });

  it('returns {ok:false, error:capture_stop_failed} when stopNativeCapture throws', async () => {
    const deps = makeRecordDeps({
      stopNativeCapture: vi.fn(async () => { throw new Error('stop failed'); }),
    });
    const result = await cmdRecordStop(deps);
    expect(result).toMatchObject({ ok: false, error: 'capture_stop_failed' });
  });
});

// ---------------------------------------------------------------------------
// cmdTranscribe
// ---------------------------------------------------------------------------

describe('cmdTranscribe', () => {
  async function makeAudioFile(): Promise<{ dir: string; filePath: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'salestalk-transcribe-test-'));
    const filePath = join(dir, 'audio.m4a');
    await writeFile(filePath, Buffer.alloc(32));
    return { dir, filePath };
  }

  function makeTranscribeDeps(overrides?: Partial<TranscribeDeps>): TranscribeDeps {
    return {
      importAudioFile: vi.fn(async () => makeAudioAsset()),
      createCall: vi.fn(async () => ({ id: 'call-1' })),
      endCall: vi.fn(async () => undefined),
      createSttJob: vi.fn(async () => makeSttJob()),
      runSttJob: vi.fn(async () => makeSttJob()),
      listTranscripts: vi.fn(async () => [makeTranscriptSegment()]),
      ...overrides,
    };
  }

  it('returns ok with callId, jobId, transcriptCount, transcripts array', async () => {
    const { dir, filePath } = await makeAudioFile();
    try {
      const deps = makeTranscribeDeps();
      const result = await cmdTranscribe({ filePath, productId: 'real_estate' }, deps);
      expect(result).toMatchObject({
        ok: true,
        callId: 'call-1',
        jobId: 'job-1',
        jobStatus: 'completed',
        transcriptCount: 1,
      });
      expect(result.ok && result.transcripts).toHaveLength(1);
      // Transcript shape
      expect(result.ok && result.transcripts[0]).toMatchObject({
        speaker: 'counterpart',
        text: 'テスト発話',
        isFinal: true,
        startMs: 0,
      });
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('returns {ok:false, error:missing_file} when no file arg', async () => {
    const deps = makeTranscribeDeps();
    const result = await cmdTranscribe({ filePath: undefined }, deps);
    expect(result).toMatchObject({ ok: false, error: 'missing_file' });
    expect(deps.importAudioFile).not.toHaveBeenCalled();
  });

  it('returns {ok:false, error:file_not_found} for nonexistent file', async () => {
    const deps = makeTranscribeDeps();
    const result = await cmdTranscribe({ filePath: '/no/such/file.m4a' }, deps);
    expect(result).toMatchObject({ ok: false, error: 'file_not_found' });
  });

  it('returns {ok:false, error:invalid_product} for bad product', async () => {
    const { dir, filePath } = await makeAudioFile();
    try {
      const deps = makeTranscribeDeps();
      const result = await cmdTranscribe({ filePath, productId: 'bad_id' }, deps);
      expect(result).toMatchObject({ ok: false, error: 'invalid_product' });
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('returns {ok:false, error:import_failed} when importAudioFile throws', async () => {
    const { dir, filePath } = await makeAudioFile();
    try {
      const deps = makeTranscribeDeps({
        importAudioFile: vi.fn(async () => { throw new Error('copy error'); }),
      });
      const result = await cmdTranscribe({ filePath }, deps);
      expect(result).toMatchObject({ ok: false, error: 'import_failed' });
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('returns {ok:false, error:stt_job_failed} when runSttJob throws', async () => {
    const { dir, filePath } = await makeAudioFile();
    try {
      const deps = makeTranscribeDeps({
        runSttJob: vi.fn(async () => { throw new Error('stt failed'); }),
      });
      const result = await cmdTranscribe({ filePath }, deps);
      expect(result).toMatchObject({ ok: false, error: 'stt_job_failed' });
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// cmdMinutes
// ---------------------------------------------------------------------------

describe('cmdMinutes', () => {
  function makeMinutesDeps(overrides?: Partial<MinutesDeps>): MinutesDeps {
    return {
      listCalls: vi.fn(async () => [
        { id: 'call-1', productId: 'real_estate' as const, source: 'uploaded_audio' as const },
      ]),
      listTranscripts: vi.fn(async () => [makeTranscriptSegment()]),
      generateMinutes: vi.fn(async () => makeMinute()),
      setLatestMinute: vi.fn(async (m) => m),
      getActiveCallId: () => null,
      ...overrides,
    };
  }

  it('returns {ok:true, minute} on success using latest call', async () => {
    const deps = makeMinutesDeps();
    const result = await cmdMinutes({}, deps);
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.minute.id).toBe('minute-1');
    expect(deps.generateMinutes).toHaveBeenCalled();
    expect(deps.setLatestMinute).toHaveBeenCalled();
  });

  it('uses provided --call-id when given', async () => {
    const deps = makeMinutesDeps();
    const result = await cmdMinutes({ callId: 'explicit-call' }, deps);
    expect(result).toMatchObject({ ok: true });
    expect(deps.generateMinutes).toHaveBeenCalledWith(
      expect.objectContaining({ callId: 'explicit-call' }),
    );
  });

  it('uses active call over most-recent call', async () => {
    const deps = makeMinutesDeps({ getActiveCallId: () => 'active-call-99' });
    await cmdMinutes({}, deps);
    expect(deps.generateMinutes).toHaveBeenCalledWith(
      expect.objectContaining({ callId: 'active-call-99' }),
    );
  });

  it('returns {ok:false, error:no_calls} when no calls exist', async () => {
    const deps = makeMinutesDeps({ listCalls: vi.fn(async () => []) });
    const result = await cmdMinutes({}, deps);
    expect(result).toMatchObject({ ok: false, error: 'no_calls' });
  });

  it('returns {ok:false, error:invalid_product} for bad product', async () => {
    const deps = makeMinutesDeps();
    const result = await cmdMinutes({ productId: 'not_valid' }, deps);
    expect(result).toMatchObject({ ok: false, error: 'invalid_product' });
  });

  it('returns {ok:false, error:minutes_generation_failed} when generateMinutes throws', async () => {
    const deps = makeMinutesDeps({
      generateMinutes: vi.fn(async () => { throw new Error('LLM timeout'); }),
    });
    const result = await cmdMinutes({}, deps);
    expect(result).toMatchObject({ ok: false, error: 'minutes_generation_failed' });
  });

  it('minute output contains expected JSON fields', async () => {
    const deps = makeMinutesDeps();
    const result = await cmdMinutes({}, deps);
    if (!result.ok) throw new Error('Expected ok');
    const minute = result.minute;
    expect(minute).toHaveProperty('id');
    expect(minute).toHaveProperty('callId');
    expect(minute).toHaveProperty('summary');
    expect(minute).toHaveProperty('agreed');
    expect(minute).toHaveProperty('pending');
    expect(minute).toHaveProperty('decisions');
    expect(minute).toHaveProperty('complianceFindings');
    expect(minute).toHaveProperty('generatedAt');
  });
});

// ---------------------------------------------------------------------------
// CLI_HELP
// ---------------------------------------------------------------------------

describe('CLI_HELP', () => {
  it('contains usage section', () => {
    expect(CLI_HELP).toContain('USAGE');
    expect(CLI_HELP).toContain('record start');
    expect(CLI_HELP).toContain('transcribe');
    expect(CLI_HELP).toContain('minutes');
    expect(CLI_HELP).toContain('salestalk://');
  });
});
