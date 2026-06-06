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
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
