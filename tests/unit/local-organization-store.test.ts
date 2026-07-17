import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalOrganizationStore } from '../../src/main/services/local-organization-store';

describe('LocalOrganizationStore', () => {
  it('seeds an insurer and its agency under one tenant', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-local-organizations-'));
    const filePath = join(directory, 'organizations.json');

    try {
      const store = new LocalOrganizationStore(filePath);
      const scope = await store.getDefaultScope();
      const organizations = await store.listOrganizations(scope.tenantId);
      const context = await store.getCurrentContext();
      const users = await store.listUsers(scope.tenantId);

      expect(organizations).toMatchObject([
        {
          type: 'insurer',
          parentOrganizationId: null,
        },
        {
          id: scope.organizationId,
          type: 'agency',
          parentOrganizationId: expect.any(String),
        },
      ]);
      expect(context).toMatchObject({
        organization: { id: scope.organizationId, type: 'agency' },
        membership: { role: 'agency_admin' },
        permissions: expect.arrayContaining([
          'recording:start',
          'checkpoints:manage',
          'organization:manage',
        ]),
      });
      expect(users).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'agency_admin', organizationId: scope.organizationId }),
          expect.objectContaining({ role: 'auditor' }),
        ]),
      );
      await expect(store.assertPermission('recording:start')).resolves.toMatchObject({
        user: { displayName: 'Agency Admin' },
      });
      const insurerUser = users.find((user) => user.role === 'auditor');
      expect(insurerUser).toBeDefined();
      expect(insurerUser?.permissions).not.toContain('checkpoints:manage');
      await expect(
        store.updateUserRole(scope.tenantId, insurerUser?.membershipId ?? '', 'insurer_admin'),
      ).resolves.toMatchObject({
        role: 'insurer_admin',
        permissions: expect.arrayContaining(['organization:manage']),
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
