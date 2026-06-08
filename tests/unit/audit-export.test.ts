import { describe, expect, it } from 'vitest';
import { createAuditCsv } from '../../src/main/services/audit-export';
import type { AuditLogEntry } from '../../src/shared/types';

describe('audit export', () => {
  it('creates a BOM-prefixed CSV with hashes and integrity status', () => {
    const csv = createAuditCsv(
      [
        {
          id: 'f620746e-38ea-4a95-950a-11ad2e13094e',
          tenantId: null,
          organizationId: null,
          actorType: 'system',
          actorUserId: null,
          actorMembershipId: null,
          actorDisplayName: null,
          actorRole: null,
          action: 'minutes.generated',
          targetType: 'meeting_minute',
          targetId: 'minute-1',
          metadata: { count: 1 },
          previousHash: null,
          hash: 'a'.repeat(64),
          createdAt: '2026-05-18T00:00:00.000Z',
        } satisfies AuditLogEntry,
      ],
      { valid: true, checkedEntries: 1, invalidEntryId: null },
    );

    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('chainValid');
    expect(csv).toContain(`"${'a'.repeat(64)}"`);
    expect(csv).toContain('"true"');
  });
});
