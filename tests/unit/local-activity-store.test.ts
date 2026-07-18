import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalActivityStore } from '../../src/main/services/local-activity-store';
import type { MeetingMinute, ReviewTask } from '../../src/shared/types';

describe('LocalActivityStore', () => {
  it('persists meeting minutes and task completion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-local-activity-'));
    const filePath = join(directory, 'activity.json');

    try {
      const store = new LocalActivityStore(filePath);
      const minute = await store.setLatestMeetingMinute({
        id: '3e5c9ec8-3c67-478a-b0a8-f05f7a9834e1',
        callId: 'ce710872-1efd-4965-8ca4-e4d13f810250',
        transcriptRevisionId: null,
        source: 'manual_transcript',
        productId: 'real_estate',
        summary: '直近の発話: 価格が高い',
        agreed: [],
        pending: ['価格が高い'],
        decisions: [],
        numbers: [{ label: 'number_1', value: '100万円' }],
        complianceFindings: [],
        generatedAt: '2026-05-18T00:00:00.000Z',
      });
      await store.createReviewTasks([
        {
          id: '06e609e4-b00e-4b22-8bd7-d93765c9b0d5',
          callId: minute.callId,
          meetingMinuteId: minute.id,
          transcriptRevisionId: null,
          findingId: '11c7cc7b-071a-46d9-a9b0-7997a6d31cd9',
          severity: 'high',
          status: 'open',
          title: '高リスク発話の確認',
          quotedText: 'この商品は絶対儲かります。',
          reason: '将来利益を断定する表現は顧客誤認につながります。',
          recommendedAction: '将来の成果は保証できないため、リスクと条件を確認します。',
          createdAt: '2026-05-18T00:00:00.000Z',
          updatedAt: '2026-05-18T00:00:00.000Z',
        },
      ]);
      await store.createTask({
        id: 'd443dd1b-d417-44f4-aae8-5c56a8ac1632',
        callId: minute.callId,
        owner: 'joint',
        description: '費用対効果の資料を送る',
        due: { kind: 'none' },
        completed: false,
        createdAt: '2026-05-18T00:00:00.000Z',
      });
      await store.appendAuditLogs([
        {
          id: 'f620746e-38ea-4a95-950a-11ad2e13094e',
          tenantId: '00000000-0000-4000-8000-000000000001',
          organizationId: '00000000-0000-4000-8000-000000000002',
          actorType: 'user',
          actorUserId: '00000000-0000-4000-8000-000000000004',
          actorMembershipId: '00000000-0000-4000-8000-000000000005',
          actorDisplayName: 'Agency Admin',
          actorRole: 'agency_admin',
          action: 'recording.started',
          targetType: 'call',
          targetId: minute.callId,
          metadata: { consentMethod: 'verbal' },
          previousHash: null,
          hash: null,
          createdAt: '2026-05-18T00:00:00.000Z',
        },
      ]);

      const restored = new LocalActivityStore(filePath);
      expect(await restored.getLatestMeetingMinute()).toEqual(minute);
      expect(await restored.getMeetingMinute(minute.callId, null)).toEqual(minute);
      expect(
        await restored.updateReviewTaskStatus(
          '06e609e4-b00e-4b22-8bd7-d93765c9b0d5',
          'training_required',
        ),
      ).toMatchObject({
        status: 'training_required',
        quotedText: 'この商品は絶対儲かります。',
      });
      expect(await restored.completeTask('d443dd1b-d417-44f4-aae8-5c56a8ac1632', true)).toMatchObject({
        completed: true,
        description: '費用対効果の資料を送る',
      });
      await expect(
        restored.listAuditLogs({
          tenantId: '00000000-0000-4000-8000-000000000001',
          organizationId: '00000000-0000-4000-8000-000000000002',
        }),
      ).resolves.toMatchObject([
        {
          action: 'recording.started',
          actorDisplayName: 'Agency Admin',
          actorRole: 'agency_admin',
        },
      ]);
      await expect(
        restored.listAuditLogs(
          { tenantId: '00000000-0000-4000-8000-000000000001' },
          { query: 'Agency Admin', action: 'recording.started', actor: 'Agency' },
        ),
      ).resolves.toHaveLength(1);
      await expect(
        restored.listAuditLogs(
          { tenantId: '00000000-0000-4000-8000-000000000001' },
          { query: 'missing' },
        ),
      ).resolves.toHaveLength(0);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('does not wipe corrupt activity data during initialization', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-local-activity-corrupt-'));
    const filePath = join(directory, 'activity.json');
    await writeFile(filePath, '{"latestMeetingMinute":', 'utf8');

    try {
      const store = new LocalActivityStore(filePath);
      await expect(store.listTasks()).rejects.toThrow();
      await expect(readFile(filePath, 'utf8')).resolves.toBe('{"latestMeetingMinute":');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('migrates legacy latest meeting minute into history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-local-activity-legacy-minute-'));
    const filePath = join(directory, 'activity.json');
    const legacyMinute = {
      id: '00000000-0000-4000-8000-000000000201',
      callId: '00000000-0000-4000-8000-000000000202',
      source: 'manual_transcript',
      productId: 'real_estate',
      summary: '旧形式の議事録',
      agreed: [],
      pending: [],
      decisions: [],
      numbers: [],
      complianceFindings: [],
      generatedAt: '2026-07-18T00:00:00.000Z',
    };
    await writeFile(
      filePath,
      `${JSON.stringify(
        {
          latestMeetingMinute: legacyMinute,
          tasks: [],
          reviewTasks: [],
          auditLogs: [],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    try {
      const store = new LocalActivityStore(filePath);
      const latest = await store.getLatestMeetingMinute();
      expect(latest).toMatchObject({
        id: legacyMinute.id,
        transcriptRevisionId: null,
      });
      await expect(store.getMeetingMinute(legacyMinute.callId, null)).resolves.toEqual(latest);

      const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
        meetingMinutes: Array<{ id: string; transcriptRevisionId: string | null }>;
      };
      expect(persisted.meetingMinutes).toEqual([
        { ...legacyMinute, transcriptRevisionId: null },
      ]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('retrieves meeting minutes by call and transcript revision', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-local-activity-revisions-'));
    const filePath = join(directory, 'activity.json');
    const callId = '00000000-0000-4000-8000-000000000301';
    const firstRevisionId = '00000000-0000-4000-8000-000000000302';
    const secondRevisionId = '00000000-0000-4000-8000-000000000303';
    const firstMinute = createMeetingMinute({
      id: '00000000-0000-4000-8000-000000000304',
      callId,
      transcriptRevisionId: firstRevisionId,
      summary: '初回解析',
    });
    const secondMinute = createMeetingMinute({
      id: '00000000-0000-4000-8000-000000000305',
      callId,
      transcriptRevisionId: secondRevisionId,
      summary: '再STT後の解析',
      generatedAt: '2026-07-18T00:01:00.000Z',
    });

    try {
      const store = new LocalActivityStore(filePath);
      await store.setMeetingAnalysis({ minute: firstMinute, reviewTasks: [] });
      await store.setMeetingAnalysis({ minute: secondMinute, reviewTasks: [] });

      await expect(store.getMeetingMinute(callId, firstRevisionId)).resolves.toEqual(firstMinute);
      await expect(store.getMeetingMinute(callId, secondRevisionId)).resolves.toEqual(secondMinute);
      await expect(store.getMeetingMinute(callId)).resolves.toEqual(secondMinute);
      await expect(store.getMeetingMinute(callId, null)).resolves.toBeNull();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('atomically replaces review tasks per revision while preserving matching status', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-local-activity-analysis-'));
    const filePath = join(directory, 'activity.json');
    const callId = '00000000-0000-4000-8000-000000000401';
    const firstRevisionId = '00000000-0000-4000-8000-000000000402';
    const secondRevisionId = '00000000-0000-4000-8000-000000000403';
    const firstMinute = createMeetingMinute({
      id: '00000000-0000-4000-8000-000000000404',
      callId,
      transcriptRevisionId: firstRevisionId,
    });
    const secondMinute = createMeetingMinute({
      id: '00000000-0000-4000-8000-000000000405',
      callId,
      transcriptRevisionId: secondRevisionId,
      summary: '別リビジョン',
    });

    try {
      const store = new LocalActivityStore(filePath);
      await store.setMeetingAnalysis({
        minute: firstMinute,
        reviewTasks: [
          createReviewTask({
            id: '00000000-0000-4000-8000-000000000406',
            callId,
            meetingMinuteId: firstMinute.id,
            transcriptRevisionId: firstRevisionId,
            quotedText: 'この商品は絶対儲かります。',
            reason: '将来利益を断定しています。',
            recommendedAction: '成果保証ではなく条件を説明します。',
          }),
          createReviewTask({
            id: '00000000-0000-4000-8000-000000000407',
            callId,
            meetingMinuteId: firstMinute.id,
            transcriptRevisionId: firstRevisionId,
            quotedText: '旧指摘',
            reason: '旧理由',
            recommendedAction: '旧対応',
          }),
        ],
      });
      await store.updateReviewTaskStatus(
        '00000000-0000-4000-8000-000000000406',
        'approved',
      );
      await store.setMeetingAnalysis({
        minute: secondMinute,
        reviewTasks: [
          createReviewTask({
            id: '00000000-0000-4000-8000-000000000408',
            callId,
            meetingMinuteId: secondMinute.id,
            transcriptRevisionId: secondRevisionId,
            quotedText: '別リビジョン指摘',
            reason: '別理由',
            recommendedAction: '別対応',
          }),
        ],
      });

      const replacementMinute = createMeetingMinute({
        id: '00000000-0000-4000-8000-000000000409',
        callId,
        transcriptRevisionId: firstRevisionId,
        summary: '同じリビジョンを再解析',
        generatedAt: '2026-07-18T00:02:00.000Z',
      });
      const result = await store.setMeetingAnalysis({
        minute: replacementMinute,
        reviewTasks: [
          createReviewTask({
            id: '00000000-0000-4000-8000-000000000410',
            callId,
            meetingMinuteId: replacementMinute.id,
            transcriptRevisionId: firstRevisionId,
            quotedText: 'この商品は絶対儲かります。',
            reason: '将来利益を断定しています。',
            recommendedAction: '成果保証ではなく条件を説明します。',
          }),
          createReviewTask({
            id: '00000000-0000-4000-8000-000000000411',
            callId,
            meetingMinuteId: replacementMinute.id,
            transcriptRevisionId: firstRevisionId,
            quotedText: '新指摘',
            reason: '新理由',
            recommendedAction: '新対応',
            status: 'escalated',
          }),
        ],
      });

      expect(result.reviewTasks).toMatchObject([
        {
          quotedText: 'この商品は絶対儲かります。',
          status: 'approved',
        },
        {
          quotedText: '新指摘',
          status: 'open',
        },
      ]);
      const tasks = await store.listReviewTasks();
      expect(
        tasks.filter(
          (task) => task.callId === callId && task.transcriptRevisionId === firstRevisionId,
        ),
      ).toHaveLength(2);
      expect(
        tasks.filter(
          (task) =>
            task.quotedText === 'この商品は絶対儲かります。' &&
            task.reason === '将来利益を断定しています。',
        ),
      ).toHaveLength(1);
      expect(tasks.some((task) => task.quotedText === '旧指摘')).toBe(false);
      expect(
        tasks.find((task) => task.transcriptRevisionId === secondRevisionId),
      ).toMatchObject({
        quotedText: '別リビジョン指摘',
        status: 'open',
      });
      await expect(store.getMeetingMinute(callId, firstRevisionId)).resolves.toEqual(
        replacementMinute,
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('binds legacy minutes and review tasks to the original transcript revision', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-local-activity-legacy-revision-'));
    const filePath = join(directory, 'activity.json');
    const callId = '00000000-0000-4000-8000-000000000501';
    const revisionId = '00000000-0000-4000-8000-000000000502';
    const minute = createMeetingMinute({
      id: '00000000-0000-4000-8000-000000000503',
      callId,
      transcriptRevisionId: null,
    });
    const reviewTask = createReviewTask({
      id: '00000000-0000-4000-8000-000000000504',
      callId,
      meetingMinuteId: minute.id,
      transcriptRevisionId: null,
    });

    try {
      const store = new LocalActivityStore(filePath);
      await store.setMeetingAnalysis({ minute, reviewTasks: [reviewTask] });

      await expect(store.bindLegacyAnalysisToRevision(callId, revisionId)).resolves.toMatchObject({
        id: minute.id,
        transcriptRevisionId: revisionId,
      });
      await expect(store.getMeetingMinute(callId, revisionId)).resolves.toMatchObject({
        id: minute.id,
        transcriptRevisionId: revisionId,
      });
      await expect(store.getMeetingMinute(callId, null)).resolves.toBeNull();
      await expect(store.listReviewTasks()).resolves.toEqual([
        expect.objectContaining({ id: reviewTask.id, transcriptRevisionId: revisionId }),
      ]);
      await expect(store.bindLegacyAnalysisToRevision(callId, revisionId)).resolves.toMatchObject({
        id: minute.id,
        transcriptRevisionId: revisionId,
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('persists audit appends durably and skips retry duplicates by id', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-local-activity-audit-'));
    const filePath = join(directory, 'activity.json');

    try {
      const store = new LocalActivityStore(filePath);
      const first = createAuditEntry('00000000-0000-4000-8000-000000000101', 1);
      const second = createAuditEntry('00000000-0000-4000-8000-000000000102', 2);

      const signed = await store.appendAuditLogs([first, second, first]);
      expect(signed.map((entry) => entry.id)).toEqual([first.id, second.id]);
      expect(signed[0]?.previousHash).toBeNull();
      expect(signed[1]?.previousHash).toBe(signed[0]?.hash);
      await expect(readFile(filePath, 'utf8')).resolves.toContain(second.id);

      const restored = new LocalActivityStore(filePath);
      await expect(restored.appendAuditLogs([first, second])).resolves.toEqual([]);
      const logs = await restored.listAuditLogs({
        tenantId: '00000000-0000-4000-8000-000000000001',
      });
      expect(logs.map((entry) => entry.id)).toEqual([second.id, first.id]);
      await expect(
        restored.verifyAuditLogs({
          tenantId: '00000000-0000-4000-8000-000000000001',
        }),
      ).resolves.toMatchObject({ valid: true, checkedEntries: 2 });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

function createMeetingMinute(overrides: Partial<MeetingMinute> = {}): MeetingMinute {
  return {
    id: '00000000-0000-4000-8000-000000000901',
    callId: '00000000-0000-4000-8000-000000000902',
    transcriptRevisionId: null,
    source: 'manual_transcript',
    productId: 'real_estate',
    summary: '解析結果',
    agreed: [],
    pending: [],
    decisions: [],
    numbers: [],
    complianceFindings: [],
    generatedAt: '2026-07-18T00:00:00.000Z',
    ...overrides,
  };
}

function createReviewTask(overrides: Partial<ReviewTask> = {}): ReviewTask {
  return {
    id: '00000000-0000-4000-8000-000000000911',
    callId: '00000000-0000-4000-8000-000000000902',
    meetingMinuteId: '00000000-0000-4000-8000-000000000901',
    transcriptRevisionId: null,
    findingId: '00000000-0000-4000-8000-000000000912',
    severity: 'high',
    status: 'open',
    title: '高リスク発話の確認',
    quotedText: '指摘対象',
    reason: '理由',
    recommendedAction: '対応',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    ...overrides,
  };
}

function createAuditEntry(id: string, sequence: number) {
  return {
    id,
    tenantId: '00000000-0000-4000-8000-000000000001',
    organizationId: '00000000-0000-4000-8000-000000000002',
    actorType: 'user' as const,
    actorUserId: '00000000-0000-4000-8000-000000000004',
    actorMembershipId: '00000000-0000-4000-8000-000000000005',
    actorDisplayName: 'Agency Admin',
    actorRole: 'agency_admin' as const,
    action: 'checkpoint.retention_updated' as const,
    targetType: 'call',
    targetId: 'ce710872-1efd-4965-8ca4-e4d13f810250',
    metadata: { sequence },
    previousHash: null,
    hash: null,
    createdAt: `2026-05-18T00:00:0${sequence}.000Z`,
  };
}
