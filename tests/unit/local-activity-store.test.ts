import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalActivityStore } from '../../src/main/services/local-activity-store';

describe('LocalActivityStore', () => {
  it('persists meeting minutes and task completion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-local-activity-'));
    const filePath = join(directory, 'activity.json');

    try {
      const store = new LocalActivityStore(filePath);
      const minute = await store.setLatestMeetingMinute({
        id: '3e5c9ec8-3c67-478a-b0a8-f05f7a9834e1',
        callId: 'ce710872-1efd-4965-8ca4-e4d13f810250',
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
