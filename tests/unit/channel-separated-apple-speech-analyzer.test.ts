import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AudioChunk, Speaker, Transcript } from '../../src/shared/types';
import { ChannelSeparatedAppleSpeechAnalyzerSTTProvider } from '../../src/main/services/channel-separated-apple-speech-analyzer';
import { AppleSpeechAnalyzerSTTProvider } from '../../src/main/services/apple-speech-analyzer';
import type { STTProvider } from '../../src/main/services/stt';

class FakeProvider implements STTProvider {
  private transcriptHandler: ((transcript: Transcript) => void) | null = null;
  readonly receivedChunks: AudioChunk[] = [];

  constructor(private readonly connectError: Error | null = null) {}

  connect = vi.fn(async () => {
    if (this.connectError) {
      throw this.connectError;
    }
  });

  disconnect = vi.fn(async () => {});

  sendAudio = vi.fn(async (chunk: AudioChunk) => {
    this.receivedChunks.push(chunk);
  });

  setTranscriptHandler(handler: (transcript: Transcript) => void): void {
    this.transcriptHandler = handler;
  }

  emit(transcript: Transcript): void {
    this.transcriptHandler?.(transcript);
  }
}

function createProvider(children: Record<Speaker, FakeProvider>): ChannelSeparatedAppleSpeechAnalyzerSTTProvider {
  return new ChannelSeparatedAppleSpeechAnalyzerSTTProvider({
    createChildProvider: (speaker) => children[speaker],
  });
}

function createChildren(
  overrides: Partial<Record<Speaker, FakeProvider>> = {},
): Record<Speaker, FakeProvider> {
  return {
    self: overrides.self ?? new FakeProvider(),
    counterpart: overrides.counterpart ?? new FakeProvider(),
  };
}

function chunk(speaker: Speaker, startMs = 0): AudioChunk {
  return {
    speaker,
    data: Buffer.from(new Int16Array([1, 2, 3]).buffer).toString('base64'),
    startMs,
    durationMs: 100,
  };
}

describe('ChannelSeparatedAppleSpeechAnalyzerSTTProvider', () => {
  it('routes audio chunks only to the provider for their speaker', async () => {
    const children = createChildren();
    const provider = createProvider(children);
    const selfChunk = chunk('self', 100);
    const counterpartChunk = chunk('counterpart', 200);

    await provider.sendAudio(selfChunk);
    await provider.sendAudio(counterpartChunk);

    expect(children.self.sendAudio).toHaveBeenCalledOnce();
    expect(children.self.receivedChunks).toEqual([selfChunk]);
    expect(children.counterpart.sendAudio).toHaveBeenCalledOnce();
    expect(children.counterpart.receivedChunks).toEqual([counterpartChunk]);
  });

  it('overwrites child transcript speaker labels with the assigned channel speaker', () => {
    const children = createChildren();
    const provider = createProvider(children);
    const transcripts: Transcript[] = [];
    provider.setTranscriptHandler((transcript) => transcripts.push(transcript));

    children.self.emit({
      speaker: 'counterpart',
      text: 'こちらで確認します',
      isFinal: true,
      startMs: 0,
      endMs: 100,
    });
    children.counterpart.emit({
      speaker: 'self',
      text: '価格が高いので判断できません',
      isFinal: false,
      startMs: 200,
    });

    expect(transcripts).toEqual([
      {
        speaker: 'self',
        text: 'こちらで確認します',
        isFinal: true,
        startMs: 0,
        endMs: 100,
      },
      {
        speaker: 'counterpart',
        text: '価格が高いので判断できません',
        isFinal: false,
        startMs: 200,
      },
    ]);
  });

  it('disconnects every child provider when one side fails to connect', async () => {
    const connectError = new Error('counterpart helper failed');
    const children = createChildren({
      counterpart: new FakeProvider(connectError),
    });
    const provider = createProvider(children);

    await expect(provider.connect()).rejects.toThrow('counterpart helper failed');

    expect(children.self.connect).toHaveBeenCalledOnce();
    expect(children.counterpart.connect).toHaveBeenCalledOnce();
    expect(children.self.disconnect).toHaveBeenCalledOnce();
    expect(children.counterpart.disconnect).toHaveBeenCalledOnce();
  });

  it('disconnects both child providers', async () => {
    const children = createChildren();
    const provider = createProvider(children);

    await provider.disconnect();

    expect(children.self.disconnect).toHaveBeenCalledOnce();
    expect(children.counterpart.disconnect).toHaveBeenCalledOnce();
  });

  it('preserves a shared timeline origin when counterpart starts 5000ms after self', async () => {
    const helperPath = await createFakeSpeechAnalyzerHelper();
    const provider = new ChannelSeparatedAppleSpeechAnalyzerSTTProvider({
      createChildProvider: (_speaker, context) =>
        new AppleSpeechAnalyzerSTTProvider({
          helperPath,
          resolveTimelineOriginMs: context.resolveTimelineOriginMs,
        }),
    });
    const transcripts: Transcript[] = [];
    provider.setTranscriptHandler((transcript) => transcripts.push(transcript));

    try {
      await provider.connect();
      await provider.sendAudio(chunk('self', 10_000));
      await provider.sendAudio(chunk('counterpart', 15_000));

      await expect.poll(() => transcripts.length, { timeout: 15_000 }).toBe(2);
      expect(transcripts.find((transcript) => transcript.speaker === 'self')).toEqual({
        speaker: 'self',
        text: 'normalized:0',
        isFinal: true,
        startMs: 0,
        endMs: 100,
      });
      expect(transcripts.find((transcript) => transcript.speaker === 'counterpart')).toEqual({
        speaker: 'counterpart',
        text: 'normalized:5000',
        isFinal: true,
        startMs: 5_000,
        endMs: 5_100,
      });
    } finally {
      await provider.disconnect();
    }
  }, 20_000);
});

async function createFakeSpeechAnalyzerHelper(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sales-talk-channel-speech-helper-'));
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
        text: 'normalized:' + message.startMs,
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
