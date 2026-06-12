import type {
  CallSession,
  MeetingSource,
  ProductId,
  RecordingConsent,
  TranscriptSegment,
} from '@shared/types';

export const PRODUCT_LABELS: Record<ProductId, string> = {
  real_estate: '不動産',
  kenko_keiei: '健康経営優良法人',
  hojokin: '補助金助成金',
};

export const SOURCE_LABELS: Record<MeetingSource, string> = {
  zoom_desktop: 'Zoom商談',
  mobile_recording: 'モバイル録音',
  uploaded_audio: '音声アップロード',
  manual_transcript: '手動transcript',
};

export function callTitle(call: CallSession): string {
  return `${PRODUCT_LABELS[call.productId]} / ${SOURCE_LABELS[call.source]}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function createUploadConsent(): RecordingConsent {
  return {
    status: 'granted',
    method: 'upload_attestation',
    capturedAt: new Date().toISOString(),
    noticeVersion: 'local-v1',
  };
}

/** Kanary 流の経過時間グルーピング(今日 / 昨日 / 過去7日 / 過去30日 / それ以前)。 */

export interface CallGroup {
  label: string;
  calls: CallSession[];
}

export function groupCallsByRecency(calls: CallSession[], now: Date): CallGroup[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const boundaries: Array<{ label: string; minStart: number }> = [
    { label: '今日', minStart: startOfToday },
    { label: '昨日', minStart: startOfToday - dayMs },
    { label: '過去7日', minStart: startOfToday - 7 * dayMs },
    { label: '過去30日', minStart: startOfToday - 30 * dayMs },
    { label: 'それ以前', minStart: Number.NEGATIVE_INFINITY },
  ];

  const sorted = [...calls].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );
  const groups = boundaries.map((boundary) => ({ label: boundary.label, calls: [] as CallSession[] }));
  for (const call of sorted) {
    const startedAt = new Date(call.startedAt).getTime();
    const index = boundaries.findIndex((boundary) => startedAt >= boundary.minStart);
    groups[index >= 0 ? index : boundaries.length - 1]?.calls.push(call);
  }
  return groups.filter((group) => group.calls.length > 0);
}

/** "25:30" 形式。終了していない call は null。 */
export function callDurationLabel(call: CallSession): string | null {
  if (!call.endedAt) {
    return null;
  }
  const durationMs = new Date(call.endedAt).getTime() - new Date(call.startedAt).getTime();
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return null;
  }
  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** 指定タイムスタンプ(ms)に再生位置が最も近いセグメントを返す。 */
export function findSegmentIndexForTimestamp(
  segments: TranscriptSegment[],
  targetMs: number,
): number {
  if (segments.length === 0) {
    return -1;
  }

  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  segments.forEach((segment, index) => {
    // 区間内ヒットを最優先、それ以外は開始位置との距離で近似
    const within =
      segment.startMs <= targetMs && (segment.endMs === null || targetMs <= segment.endMs);
    const distance = within ? 0 : Math.abs(segment.startMs - targetMs);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

/** 引用テキストに最も一致するセグメントを返す(コンプラ finding → 発話ジャンプ用)。 */
export function findSegmentIndexByQuote(segments: TranscriptSegment[], quote: string): number {
  const normalizedQuote = normalizeForMatch(quote);
  if (!normalizedQuote) {
    return -1;
  }

  let bestIndex = -1;
  let bestScore = 0;
  segments.forEach((segment, index) => {
    const normalizedText = normalizeForMatch(segment.text);
    if (!normalizedText) {
      return;
    }
    if (normalizedText.includes(normalizedQuote) || normalizedQuote.includes(normalizedText)) {
      const score = Math.min(normalizedText.length, normalizedQuote.length);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
  });
  return bestIndex;
}

function normalizeForMatch(text: string): string {
  return text.replace(/[\s、。,.!?！?]/g, '');
}
