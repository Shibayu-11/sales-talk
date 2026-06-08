import { createHash } from 'node:crypto';
import type { AuditIntegrityResult, AuditLogEntry } from '@shared/types';

export function signAuditLogEntries(
  entries: AuditLogEntry[],
  previousHash: string | null,
): AuditLogEntry[] {
  let chainHash = previousHash;
  return entries.map((entry) => {
    const signed = {
      ...entry,
      previousHash: chainHash,
      hash: calculateAuditLogHash(entry, chainHash),
    };
    chainHash = signed.hash;
    return signed;
  });
}

export function verifyAuditLogChain(entriesNewestFirst: AuditLogEntry[]): AuditIntegrityResult {
  const entries = [...entriesNewestFirst].reverse();
  let previousHash: string | null = null;
  for (const entry of entries) {
    if (
      entry.previousHash !== previousHash ||
      entry.hash === null ||
      entry.hash !== calculateAuditLogHash(entry, previousHash)
    ) {
      return {
        valid: false,
        checkedEntries: entries.length,
        invalidEntryId: entry.id,
      };
    }
    previousHash = entry.hash;
  }
  return { valid: true, checkedEntries: entries.length, invalidEntryId: null };
}

function calculateAuditLogHash(entry: AuditLogEntry, previousHash: string | null): string {
  const payload = {
    id: entry.id,
    tenantId: entry.tenantId,
    organizationId: entry.organizationId,
    actorType: entry.actorType,
    actorUserId: entry.actorUserId,
    actorMembershipId: entry.actorMembershipId,
    actorDisplayName: entry.actorDisplayName,
    actorRole: entry.actorRole,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    metadata: entry.metadata,
    previousHash,
    createdAt: entry.createdAt,
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
