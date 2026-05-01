import { describe, expect, it } from 'vitest';
import {
  createInitialAudioCaptureStats,
  updateAudioCaptureStats,
} from '../../src/main/audio/audio-capture-stats';

describe('audio capture stats', () => {
  it('starts with zeroed source and total stats', () => {
    expect(createInitialAudioCaptureStats()).toEqual({
      self: { chunks: 0, bytes: 0, lastReceivedAtMs: null },
      counterpart: { chunks: 0, bytes: 0, lastReceivedAtMs: null },
      total: { chunks: 0, bytes: 0, lastReceivedAtMs: null },
    });
  });

  it('updates self and total stats from base64 audio payload bytes', () => {
    const stats = updateAudioCaptureStats(
      createInitialAudioCaptureStats(),
      {
        speaker: 'self',
        data: Buffer.from([1, 2, 3, 4]).toString('base64'),
        startMs: 0,
        durationMs: 100,
      },
      1234,
    );

    expect(stats.self).toEqual({ chunks: 1, bytes: 4, lastReceivedAtMs: 1234 });
    expect(stats.counterpart).toEqual({ chunks: 0, bytes: 0, lastReceivedAtMs: null });
    expect(stats.total).toEqual({ chunks: 1, bytes: 4, lastReceivedAtMs: 1234 });
  });

  it('keeps speaker stats separate while aggregating totals', () => {
    const initial = createInitialAudioCaptureStats();
    const withSelf = updateAudioCaptureStats(
      initial,
      {
        speaker: 'self',
        data: Buffer.from([1, 2]).toString('base64'),
        startMs: 0,
        durationMs: 100,
      },
      1000,
    );
    const withCounterpart = updateAudioCaptureStats(
      withSelf,
      {
        speaker: 'counterpart',
        data: Buffer.from([3, 4, 5]).toString('base64'),
        startMs: 100,
        durationMs: 100,
      },
      2000,
    );

    expect(withCounterpart.self).toEqual({ chunks: 1, bytes: 2, lastReceivedAtMs: 1000 });
    expect(withCounterpart.counterpart).toEqual({ chunks: 1, bytes: 3, lastReceivedAtMs: 2000 });
    expect(withCounterpart.total).toEqual({ chunks: 2, bytes: 5, lastReceivedAtMs: 2000 });
  });
});
