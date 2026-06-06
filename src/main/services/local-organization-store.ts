import { app } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { OrganizationSchema, TenantSchema } from '@shared/schemas';
import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_PARENT_ORGANIZATION_ID,
  DEFAULT_TENANT_ID,
} from '@shared/organization-constants';
import type { Organization, Tenant } from '@shared/types';

const LocalOrganizationDataSchema = z.object({
  tenants: z.array(TenantSchema),
  organizations: z.array(OrganizationSchema),
});

interface LocalOrganizationData {
  tenants: Tenant[];
  organizations: Organization[];
}

export class LocalOrganizationStore {
  private cache: LocalOrganizationData | null = null;

  constructor(private readonly filePath = join(defaultUserDataPath(), 'local-organizations.json')) {}

  async getDefaultScope(): Promise<{ tenantId: string; organizationId: string }> {
    const data = await this.get();
    const organization = data.organizations.find(
      (candidate) => candidate.id === DEFAULT_ORGANIZATION_ID,
    );
    if (!organization) {
      throw new Error('Default organization was not found');
    }
    return { tenantId: organization.tenantId, organizationId: organization.id };
  }

  async listOrganizations(tenantId: string): Promise<Organization[]> {
    const data = await this.get();
    return data.organizations.filter((organization) => organization.tenantId === tenantId);
  }

  private async get(): Promise<LocalOrganizationData> {
    if (this.cache) {
      return this.cache;
    }

    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.cache = LocalOrganizationDataSchema.parse(JSON.parse(raw));
      return this.cache;
    } catch {
      this.cache = createDefaultOrganizationData();
      await this.persist(this.cache);
      return this.cache;
    }
  }

  private async persist(data: LocalOrganizationData): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }
}

export const localOrganizationStore = new LocalOrganizationStore();

function createDefaultOrganizationData(): LocalOrganizationData {
  const now = new Date().toISOString();
  return {
    tenants: [
      {
        id: DEFAULT_TENANT_ID,
        name: 'Local Insurance Group',
        createdAt: now,
        updatedAt: now,
      },
    ],
    organizations: [
      {
        id: DEFAULT_PARENT_ORGANIZATION_ID,
        tenantId: DEFAULT_TENANT_ID,
        parentOrganizationId: null,
        type: 'insurer',
        name: 'Local Insurance Company',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: DEFAULT_ORGANIZATION_ID,
        tenantId: DEFAULT_TENANT_ID,
        parentOrganizationId: DEFAULT_PARENT_ORGANIZATION_ID,
        type: 'agency',
        name: 'Local Insurance Agency',
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}

function defaultUserDataPath(): string {
  return process.env.SALES_TALK_USER_DATA_PATH ?? app?.getPath?.('userData') ?? process.cwd();
}
