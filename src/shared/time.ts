/** 議事録の決定事項等に埋め込む `[mm:ss]` 形式。transcript セグメントへのジャンプリンクの共通表現。 */

export function formatMmSs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export interface LeadingTimestamp {
  ms: number;
  label: string;
  rest: string;
}

/** `[12:34] 本文` 形式の先頭タイムスタンプを取り出す。なければ null。 */
export function parseLeadingTimestamp(text: string): LeadingTimestamp | null {
  const match = /^\s*\[(\d{1,3}):([0-5]\d)\]\s*(.*)$/s.exec(text);
  if (!match) {
    return null;
  }
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  return {
    ms: (minutes * 60 + seconds) * 1000,
    label: `${String(minutes).padStart(2, '0')}:${match[2]}`,
    rest: match[3] ?? '',
  };
}
