import { describe, expect, it } from 'vitest';
import type { CallSession, TranscriptSegment } from '../../src/shared/types';
import { formatMmSs, parseLeadingTimestamp } from '../../src/shared/time';
import {
  callDurationLabel,
  callTitle,
  findSegmentIndexByQuote,
  findSegmentIndexForTimestamp,
  groupCallsByRecency,
} from '../../src/renderer/control/src/lib/call-view';

function call(id: string, startedAt: string, endedAt: string | null = null): CallSession {
  return {
    id,
    tenantId: 'tenant',
    organizationId: 'org',
    source: 'zoom_desktop',
    industry: 'btob_sales',
    productId: 'real_estate',
    recordingConsent: {
      status: 'granted',
      method: 'verbal',
      capturedAt: startedAt,
      noticeVersion: 'local-v1',
    },
    status: endedAt ? 'ended' : 'active',
    startedAt,
    endedAt,
    createdAt: startedAt,
    updatedAt: startedAt,
  };
}

function segment(id: string, text: string, startMs: number, endMs: number | null): TranscriptSegment {
  return {
    id,
    callId: 'call-1',
    revisionId: null,
    sourceJobId: null,
    speaker: 'counterpart',
    text,
    isFinal: true,
    startMs,
    endMs,
    createdAt: '2026-06-12T00:00:00Z',
  };
}

describe('time helpers', () => {
  it('formats and parses mm:ss timestamps round-trip', () => {
    expect(formatMmSs(65_000)).toBe('01:05');
    expect(formatMmSs(0)).toBe('00:00');
    expect(parseLeadingTimestamp('[01:05] 7月導入を決定')).toEqual({
      ms: 65_000,
      label: '01:05',
      rest: '7月導入を決定',
    });
    expect(parseLeadingTimestamp('タイムスタンプなし')).toBeNull();
  });
});

describe('groupCallsByRecency', () => {
  it('groups calls into recency buckets like Kanary sidebar', () => {
    const now = new Date('2026-06-12T15:00:00');
    const groups = groupCallsByRecency(
      [
        call('today', '2026-06-12T10:00:00'),
        call('yesterday', '2026-06-11T18:00:00'),
        call('lastweek', '2026-06-07T09:00:00'),
        call('lastmonth', '2026-05-20T09:00:00'),
        call('old', '2026-01-01T09:00:00'),
      ],
      now,
    );

    expect(groups.map((group) => group.label)).toEqual([
      '今日',
      '昨日',
      '過去7日',
      '過去30日',
      'それ以前',
    ]);
    expect(groups[0]?.calls.map((c) => c.id)).toEqual(['today']);
    expect(groups[2]?.calls.map((c) => c.id)).toEqual(['lastweek']);
  });

  it('sorts calls newest first within groups and drops empty groups', () => {
    const now = new Date('2026-06-12T15:00:00');
    const groups = groupCallsByRecency(
      [call('a', '2026-06-12T09:00:00'), call('b', '2026-06-12T11:00:00')],
      now,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.calls.map((c) => c.id)).toEqual(['b', 'a']);
  });
});

describe('callDurationLabel / callTitle', () => {
  it('renders duration for ended calls and null otherwise', () => {
    expect(
      callDurationLabel(call('x', '2026-06-12T10:00:00', '2026-06-12T10:25:30')),
    ).toBe('25:30');
    expect(callDurationLabel(call('y', '2026-06-12T10:00:00'))).toBeNull();
  });

  it('builds a human title from product and source', () => {
    expect(callTitle(call('x', '2026-06-12T10:00:00'))).toBe('不動産 / Zoom商談');
  });
});

describe('segment lookup', () => {
  const segments = [
    segment('s1', '本日はありがとうございます', 0, 4_000),
    segment('s2', '価格が高いと感じています', 60_000, 66_000),
    segment('s3', '7月導入を前提に進めましょう', 120_000, 130_000),
  ];

  it('finds the segment containing the timestamp', () => {
    expect(findSegmentIndexForTimestamp(segments, 65_000)).toBe(1);
  });

  it('falls back to the nearest segment start', () => {
    expect(findSegmentIndexForTimestamp(segments, 110_000)).toBe(2);
    expect(findSegmentIndexForTimestamp([], 0)).toBe(-1);
  });

  it('matches compliance quotes to segments ignoring punctuation', () => {
    expect(findSegmentIndexByQuote(segments, '価格が高い、と感じています。')).toBe(1);
    expect(findSegmentIndexByQuote(segments, '存在しない発話')).toBe(-1);
  });
});
