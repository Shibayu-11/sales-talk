import { describe, expect, it } from 'vitest';
import { parseDeepgramPrerecorded } from '../../cloudflare/src/stt';

describe('Cloudflare STT helpers', () => {
  it('maps Deepgram prerecorded response to one final transcript segment', () => {
    expect(
      parseDeepgramPrerecorded({
        results: {
          channels: [
            {
              alternatives: [
                {
                  transcript: '保険の説明を受けました。',
                  paragraphs: { transcript: '保険の説明を受けました。' },
                  words: [
                    { word: '保険', start: 0.1, end: 0.4 },
                    { word: '説明', start: 0.5, end: 1.2 },
                  ],
                },
              ],
            },
          ],
        },
      }),
    ).toEqual([
      {
        text: '保険の説明を受けました。',
        startMs: 100,
        endMs: 1200,
      },
    ]);
  });

  it('ignores empty transcripts', () => {
    expect(
      parseDeepgramPrerecorded({
        results: {
          channels: [{ alternatives: [{ transcript: '', words: [] }] }],
        },
      }),
    ).toEqual([]);
  });
});
