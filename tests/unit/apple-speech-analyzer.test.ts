import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AppleSpeechAnalyzerSTTProvider,
  createAppleSpeechAnalyzerSTTProvider,
} from '../../src/main/services/apple-speech-analyzer';
import { ChannelSeparatedAppleSpeechAnalyzerSTTProvider } from '../../src/main/services/channel-separated-apple-speech-analyzer';
import type { Transcript } from '../../src/shared/types';

describe('AppleSpeechAnalyzerSTTProvider', () => {
  it('converts helper transcript messages into STT transcripts', async () => {
    const helperPath = await createFakeSpeechAnalyzerHelper();
    const provider = new AppleSpeechAnalyzerSTTProvider({ helperPath });
    const transcripts: Transcript[] = [];
    provider.setTranscriptHandler((transcript) => transcripts.push(transcript));

    await provider.connect();
    await provider.sendAudio({
      speaker: 'counterpart',
      data: Buffer.from(new Int16Array([1, 2, 3]).buffer).toString('base64'),
      startMs: 120,
      durationMs: 100,
    });

    // Spawns a real node subprocess; allow generous polling under parallel load.
    await expect.poll(() => transcripts.length, { timeout: 15_000 }).toBe(1);
    expect(transcripts[0]).toEqual({
      speaker: 'counterpart',
      text: '保険料が高いですね',
      isFinal: true,
      startMs: 0,
      endMs: 100,
    });

    await provider.disconnect();
  }, 20_000);

  it('fails fast when the helper binary is missing', async () => {
    const provider = new AppleSpeechAnalyzerSTTProvider({ helperPath: '/tmp/sales-talk-missing-helper' });

    await expect(provider.connect()).rejects.toThrow('Apple SpeechAnalyzer helper was not found');
  });

  it('creates the channel-separated provider from the realtime factory', async () => {
    const helperPath = await createFakeSpeechAnalyzerHelper();
    const previousHelperPath = process.env.SALES_TALK_SPEECH_ANALYZER_HELPER;
    process.env.SALES_TALK_SPEECH_ANALYZER_HELPER = helperPath;

    try {
      const provider = await createAppleSpeechAnalyzerSTTProvider();
      expect(provider).toBeInstanceOf(ChannelSeparatedAppleSpeechAnalyzerSTTProvider);
    } finally {
      if (previousHelperPath === undefined) {
        delete process.env.SALES_TALK_SPEECH_ANALYZER_HELPER;
      } else {
        process.env.SALES_TALK_SPEECH_ANALYZER_HELPER = previousHelperPath;
      }
    }
  });
});

async function createFakeSpeechAnalyzerHelper(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sales-talk-speech-helper-'));
  const helperPath = join(directory, 'speech-analyzer-helper');
  await writeFile(
    helperPath,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'ready', sampleRate: 16000 }) + '\\n');
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf('\\n');
    if (index === -1) break;
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    const message = JSON.parse(line);
    if (message.type === 'stop') process.exit(0);
    if (message.type === 'audio') {
      process.stdout.write(JSON.stringify({
        type: 'transcript',
        speaker: 'counterpart',
        text: '保険料が高いですね',
        isFinal: true,
        startMs: message.startMs,
        endMs: message.startMs + 100
      }) + '\\n');
    }
  }
});
`,
    'utf8',
  );
  await chmod(helperPath, 0o755);
  return helperPath;
}
