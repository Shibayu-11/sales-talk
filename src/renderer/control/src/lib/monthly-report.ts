import type { ComplianceSeverity, ReviewTask, ReviewTaskStatus } from '@shared/types';

/**
 * Monthly compliance-review aggregation for the manager dashboard.
 * Pure so the metrics (Track B success indicators: 重大リスク検知件数 / 処理状況 /
 * 要確認商談数) are unit-testable independent of React.
 */

export type SeverityCounts = Record<ComplianceSeverity, number>;
export type StatusCounts = Record<ReviewTaskStatus, number>;

export interface MonthlyReviewSummary {
  /** YYYY-MM (local time). */
  month: string;
  total: number;
  bySeverity: SeverityCounts;
  byStatus: StatusCounts;
  /** critical + high. */
  highRisk: number;
  /** tasks no longer 'open'. */
  resolved: number;
  /** resolved / total, 0 when empty. */
  resolutionRate: number;
}

const SEVERITIES: ComplianceSeverity[] = ['critical', 'high', 'medium', 'low'];
const STATUSES: ReviewTaskStatus[] = [
  'open',
  'approved',
  'dismissed',
  'training_required',
  'escalated',
];

function emptySeverityCounts(): SeverityCounts {
  return { critical: 0, high: 0, medium: 0, low: 0 };
}

function emptyStatusCounts(): StatusCounts {
  return { open: 0, approved: 0, dismissed: 0, training_required: 0, escalated: 0 };
}

/** YYYY-MM in local time from an ISO timestamp. */
export function monthKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Newest month first. */
export function summarizeReviewTasksByMonth(tasks: ReviewTask[]): MonthlyReviewSummary[] {
  const byMonth = new Map<string, ReviewTask[]>();
  for (const task of tasks) {
    const key = monthKey(task.createdAt);
    const bucket = byMonth.get(key);
    if (bucket) bucket.push(task);
    else byMonth.set(key, [task]);
  }

  return [...byMonth.entries()]
    .map(([month, monthTasks]) => summarizeOneMonth(month, monthTasks))
    .sort((a, b) => b.month.localeCompare(a.month));
}

function summarizeOneMonth(month: string, tasks: ReviewTask[]): MonthlyReviewSummary {
  const bySeverity = emptySeverityCounts();
  const byStatus = emptyStatusCounts();
  for (const task of tasks) {
    if (SEVERITIES.includes(task.severity)) bySeverity[task.severity] += 1;
    if (STATUSES.includes(task.status)) byStatus[task.status] += 1;
  }
  const total = tasks.length;
  const highRisk = bySeverity.critical + bySeverity.high;
  const resolved = total - byStatus.open;
  return {
    month,
    total,
    bySeverity,
    byStatus,
    highRisk,
    resolved,
    resolutionRate: total === 0 ? 0 : resolved / total,
  };
}

/** Display label like "2026年6月" from a YYYY-MM key. */
export function formatMonthLabel(month: string): string {
  const [year, m] = month.split('-');
  return `${year}年${Number(m)}月`;
}
