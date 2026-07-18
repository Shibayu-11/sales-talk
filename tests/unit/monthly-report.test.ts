import { describe, expect, it } from 'vitest';
import type { ComplianceSeverity, ReviewTask, ReviewTaskStatus } from '../../src/shared/types';
import {
  formatMonthLabel,
  monthKey,
  summarizeReviewTasksByMonth,
} from '../../src/renderer/control/src/lib/monthly-report';

function task(
  createdAt: string,
  severity: ComplianceSeverity,
  status: ReviewTaskStatus,
): ReviewTask {
  return {
    id: `${createdAt}-${severity}-${status}`,
    callId: 'c',
    transcriptRevisionId: null,
    meetingMinuteId: 'm',
    findingId: 'f',
    severity,
    status,
    title: 't',
    quotedText: 'q',
    reason: 'r',
    recommendedAction: 'a',
    createdAt,
    updatedAt: createdAt,
  };
}

describe('monthKey / formatMonthLabel', () => {
  it('derives a YYYY-MM key and a Japanese label', () => {
    expect(monthKey('2026-06-15T10:00:00')).toBe('2026-06');
    expect(formatMonthLabel('2026-06')).toBe('2026年6月');
  });
});

describe('summarizeReviewTasksByMonth', () => {
  it('groups by month newest-first with severity and status counts', () => {
    const summaries = summarizeReviewTasksByMonth([
      task('2026-06-01T09:00:00', 'critical', 'open'),
      task('2026-06-20T09:00:00', 'high', 'approved'),
      task('2026-06-25T09:00:00', 'medium', 'training_required'),
      task('2026-05-10T09:00:00', 'low', 'dismissed'),
    ]);

    expect(summaries.map((s) => s.month)).toEqual(['2026-06', '2026-05']);

    const june = summaries[0]!;
    expect(june.total).toBe(3);
    expect(june.bySeverity).toEqual({ critical: 1, high: 1, medium: 1, low: 0 });
    expect(june.highRisk).toBe(2); // critical + high
    expect(june.byStatus.open).toBe(1);
    expect(june.resolved).toBe(2); // approved + training_required
    expect(june.resolutionRate).toBeCloseTo(2 / 3);
  });

  it('returns an empty array for no tasks', () => {
    expect(summarizeReviewTasksByMonth([])).toEqual([]);
  });

  it('reports 0 resolution rate when every task is still open', () => {
    const summaries = summarizeReviewTasksByMonth([
      task('2026-06-01T09:00:00', 'high', 'open'),
      task('2026-06-02T09:00:00', 'critical', 'open'),
    ]);
    expect(summaries[0]!.resolutionRate).toBe(0);
    expect(summaries[0]!.highRisk).toBe(2);
  });

  it('counts escalations and full resolution', () => {
    const summaries = summarizeReviewTasksByMonth([
      task('2026-06-01T09:00:00', 'critical', 'escalated'),
      task('2026-06-02T09:00:00', 'high', 'approved'),
    ]);
    expect(summaries[0]!.byStatus.escalated).toBe(1);
    expect(summaries[0]!.resolutionRate).toBe(1);
  });
});
