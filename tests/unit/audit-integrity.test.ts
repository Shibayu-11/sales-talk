import { describe, expect, it } from 'vitest';
import type { AuditLogEntry } from '../../src/shared/types';
import {
  signAuditLogEntries,
  verifyAuditLogChain,
} from '../../src/main/services/audit-integrity';

describe('audit integrity', () => {
  it('detects a modified signed audit entry', () => {
    const entries = signAuditLogEntries([createEntry('recording.started')], null);
    expect(verifyAuditLogChain([...entries].reverse())).toMatchObject({ valid: true });

    const modified = [{ ...entries[0]!, action: 'recording.consent_captured' as const }];
    expect(verifyAuditLogChain(modified)).toMatchObject({
      valid: false,
      invalidEntryId: entries[0]!.id,
    });
  });
});

function createEntry(action: AuditLogEntry['action']): AuditLogEntry {
  return {
    id: 'f620746e-38ea-4a95-950a-11ad2e13094e',
    tenantId: '00000000-0000-4000-8000-000000000001',
    organizationId: '00000000-0000-4000-8000-000000000002',
    actorType: 'user',
    actorUserId: '00000000-0000-4000-8000-000000000004',
    actorMembershipId: '00000000-0000-4000-8000-000000000005',
    actorDisplayName: 'Agency Admin',
    actorRole: 'agency_admin',
    action,
    targetType: 'call',
    targetId: 'ce710872-1efd-4965-8ca4-e4d13f810250',
    metadata: { consentMethod: 'verbal' },
    previousHash: null,
    hash: null,
    createdAt: '2026-05-18T00:00:00.000Z',
  };
}
