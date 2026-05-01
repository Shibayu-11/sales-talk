import type { AudioCaptureStats, AudioChunk, Speaker } from '@shared/types';

export function createInitialAudioCaptureStats(): AudioCaptureStats {
  return {
    self: createInitialSourceStats(),
    counterpart: createInitialSourceStats(),
    total: createInitialSourceStats(),
  };
}

export function updateAudioCaptureStats(
  stats: AudioCaptureStats,
  chunk: AudioChunk,
  receivedAtMs = Date.now(),
): AudioCaptureStats {
  const bytes = Buffer.byteLength(chunk.data, 'base64');
  return {
    ...stats,
    [chunk.speaker]: updateSourceStats(stats[chunk.speaker], bytes, receivedAtMs),
    total: updateSourceStats(stats.total, bytes, receivedAtMs),
  };
}

function createInitialSourceStats(): AudioCaptureStats[Speaker] {
  return {
    chunks: 0,
    bytes: 0,
    lastReceivedAtMs: null,
  };
}

function updateSourceStats(
  stats: AudioCaptureStats[Speaker],
  bytes: number,
  receivedAtMs: number,
): AudioCaptureStats[Speaker] {
  return {
    chunks: stats.chunks + 1,
    bytes: stats.bytes + bytes,
    lastReceivedAtMs: receivedAtMs,
  };
}
