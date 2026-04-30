import { describe, expect, it } from 'vitest';
import { parseDeepgramTranscriptMessage } from '../../src/main/services/deepgram';

describe('parseDeepgramTranscriptMessage', () => {
  it('maps interim Deepgram results to interim transcripts', () => {
    const transcript = parseDeepgramTranscriptMessage(
      JSON.stringify({
        type: 'Results',
        start: 1.25,
        duration: 0.5,
        is_final: false,
        channel: { alternatives: [{ transcript: '価格が高いですね' }] },
      }),
      'counterpart',
    );

    expect(transcript).toEqual({
      speaker: 'counterpart',
      text: '価格が高いですね',
      isFinal: false,
      startMs: 1_250,
    });
  });

  it('maps final Deepgram results to final transcripts', () => {
    const transcript = parseDeepgramTranscriptMessage(
      JSON.stringify({
        type: 'Results',
        start: 2,
        duration: 1.2,
        is_final: true,
        channel: { alternatives: [{ transcript: '導入時期が合いません' }] },
      }),
      'counterpart',
    );

    expect(transcript).toEqual({
      speaker: 'counterpart',
      text: '導入時期が合いません',
      isFinal: true,
      startMs: 2_000,
      endMs: 3_200,
    });
  });

  it('ignores non-result or empty transcript messages', () => {
    expect(parseDeepgramTranscriptMessage('{"type":"Metadata"}', 'counterpart')).toBeNull();
    expect(
      parseDeepgramTranscriptMessage(
        JSON.stringify({
          type: 'Results',
          channel: { alternatives: [{ transcript: '' }] },
        }),
        'counterpart',
      ),
    ).toBeNull();
  });
});
