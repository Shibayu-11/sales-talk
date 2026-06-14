import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppleSpeechAnalyzerBatchTranscriber } from '../../src/main/services/apple-speech-analyzer-batch';
import type { AudioAsset } from '../../src/shared/types';

const FAKE_ASSET: AudioAsset = {
  id: 'a1b2c3d4-0000-4000-8000-000000000001',
  callId: 'c1b2c3d4-0000-4000-8000-000000000001',
  fileName: 'sample.m4a',
  originalPath: '/tmp/sample.m4a',
  storedPath: '/tmp/sample.m4a',
  mimeType: 'audio/mp4',
  sizeBytes: 1024,
  createdAt: '2026-06-14T00:00:00.000Z',
};

describe('AppleSpeechAnalyzerBatchTranscriber', () => {
  it('returns false from isAvailable when helper binary is missing', () => {
    const transcriber = new AppleSpeechAnalyzerBatchTranscriber({
      helperPath: '/tmp/sales-talk-missing-batch-helper-nonexistent',
    });
    expect(transcriber.isAvailable()).toBe(false);
  });

  it('rejects transcribeFile when helper binary is missing', async () => {
    const transcriber = new AppleSpeechAnalyzerBatchTranscriber({
      helperPath: '/tmp/sales-talk-missing-batch-helper-nonexistent',
    });
    await expect(transcriber.transcribeFile(FAKE_ASSET)).rejects.toThrow(
      'Apple SpeechAnalyzer helper was not found',
    );
  });

  it('collects transcript events from helper and resolves with FinalTranscript[]', async () => {
    const helperPath = await createFakeBatchHelper({
      transcripts: [
        { text: '保険料が高いですね', startMs: 100, endMs: 500 },
        { text: '考えさせてください', startMs: 600, endMs: 1000 },
      ],
    });
    const transcriber = new AppleSpeechAnalyzerBatchTranscriber({ helperPath });

    const results = await transcriber.transcribeFile(FAKE_ASSET);

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      speaker: 'counterpart',
      text: '保険料が高いですね',
      isFinal: true,
      startMs: 100,
      endMs: 500,
    });
    expect(results[1]).toEqual({
      speaker: 'counterpart',
      text: '考えさせてください',
      isFinal: true,
      startMs: 600,
      endMs: 1000,
    });
  });

  it('returns empty array when helper emits done with no transcripts', async () => {
    const helperPath = await createFakeBatchHelper({ transcripts: [] });
    const transcriber = new AppleSpeechAnalyzerBatchTranscriber({ helperPath });

    const results = await transcriber.transcribeFile(FAKE_ASSET);
    expect(results).toEqual([]);
  });

  it('rejects when helper emits an error message', async () => {
    const helperPath = await createFakeBatchHelper({
      error: { code: 'speech_file_read_failed', message: 'file not found' },
    });
    const transcriber = new AppleSpeechAnalyzerBatchTranscriber({ helperPath });

    await expect(transcriber.transcribeFile(FAKE_ASSET)).rejects.toThrow(
      'speech_file_read_failed',
    );
  });

  it('resolves when helper exits code 0 without explicit done (graceful)', async () => {
    const helperPath = await createFakeBatchHelper({ transcripts: [], exitWithoutDone: true });
    const transcriber = new AppleSpeechAnalyzerBatchTranscriber({ helperPath });

    const results = await transcriber.transcribeFile(FAKE_ASSET);
    expect(results).toEqual([]);
  });
});

interface FakeHelperOptions {
  transcripts?: { text: string; startMs: number; endMs: number }[];
  error?: { code: string; message: string };
  exitWithoutDone?: boolean;
}

async function createFakeBatchHelper(options: FakeHelperOptions): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sales-talk-batch-helper-'));
  const helperPath = join(directory, 'speech-analyzer-helper');

  const transcriptLines = (options.transcripts ?? [])
    .map((t) =>
      JSON.stringify({
        type: 'transcript',
        speaker: 'counterpart',
        text: t.text,
        isFinal: true,
        startMs: t.startMs,
        endMs: t.endMs,
      }),
    )
    .map((l) => `process.stdout.write(${JSON.stringify(l)} + '\\n');`)
    .join('\n');

  const errorLine = options.error
    ? `process.stdout.write(${JSON.stringify(JSON.stringify({ type: 'error', code: options.error.code, message: options.error.message }))} + '\\n');`
    : '';

  const doneLine = options.exitWithoutDone
    ? '// no done message — exit 0 directly'
    : `process.stdout.write(JSON.stringify({ type: 'done' }) + '\\n');`;

  await writeFile(
    helperPath,
    `#!/usr/bin/env node
// Fake batch helper for AppleSpeechAnalyzerBatchTranscriber tests
process.stdin.resume();
process.stdin.once('data', () => {
  ${transcriptLines}
  ${errorLine}
  ${doneLine}
  process.exit(0);
});
`,
    'utf8',
  );
  await chmod(helperPath, 0o755);
  return helperPath;
}
