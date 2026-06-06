import { app } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  AppUserSchema,
  OrganizationMembershipSchema,
  OrganizationSchema,
  TenantSchema,
} from '@shared/schemas';
import {
  DEFAULT_INSURER_MEMBERSHIP_ID,
  DEFAULT_INSURER_USER_ID,
  DEFAULT_MEMBERSHIP_ID,
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_PARENT_ORGANIZATION_ID,
  DEFAULT_TENANT_ID,
  DEFAULT_USER_ID,
} from '@shared/organization-constants';
import { getRolePermissions } from '@shared/organization-permissions';
import type {
  AppUser,
  CurrentUserContext,
  Organization,
  OrganizationMembership,
  OrganizationPermission,
  OrganizationRole,
  OrganizationUser,
  Tenant,
} from '@shared/types';

const LocalOrganizationDataSchema = z.object({
  tenants: z.array(TenantSchema),
  organizations: z.array(OrganizationSchema),
  users: z.array(AppUserSchema).default([]),
  memberships: z.array(OrganizationMembershipSchema).default([]),
});

interface LocalOrganizationData {
  tenants: Tenant[];
  organizations: Organization[];
  users: AppUser[];
  memberships: OrganizationMembership[];
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

  async getCurrentContext(): Promise<CurrentUserContext> {
    const data = await this.get();
    const user = data.users.find((candidate) => candidate.id === DEFAULT_USER_ID);
    const membership = data.memberships.find((candidate) => candidate.userId === DEFAULT_USER_ID);
    const tenant = data.tenants.find((candidate) => candidate.id === membership?.tenantId);
    const organization = data.organizations.find(
      (candidate) => candidate.id === membership?.organizationId,
    );
    if (!user || !membership || !tenant || !organization) {
      throw new Error('Current organization user context was not found');
    }
    return {
      user,
      tenant,
      organization,
      membership,
      permissions: getRolePermissions(membership.role),
    };
  }

  async listUsers(tenantId: string): Promise<OrganizationUser[]> {
    const data = await this.get();
    return data.memberships
      .filter((membership) => membership.tenantId === tenantId)
      .flatMap((membership) => {
        const user = data.users.find((candidate) => candidate.id === membership.userId);
        return user
          ? [
              {
                ...user,
                membershipId: membership.id,
                tenantId: membership.tenantId,
                organizationId: membership.organizationId,
                role: membership.role,
                permissions: getRolePermissions(membership.role),
              },
            ]
          : [];
      });
  }

  async assertPermission(permission: OrganizationPermission): Promise<CurrentUserContext> {
    const context = await this.getCurrentContext();
    if (!context.permissions.includes(permission)) {
      throw new Error(`Current user does not have permission: ${permission}`);
    }
    return context;
  }

  async updateUserRole(
    tenantId: string,
    membershipId: string,
    role: OrganizationRole,
  ): Promise<OrganizationUser> {
    const data = await this.get();
    const membershipIndex = data.memberships.findIndex(
      (candidate) => candidate.id === membershipId && candidate.tenantId === tenantId,
    );
    const membership = data.memberships[membershipIndex];
    if (!membership) {
      throw new Error('Organization membership was not found');
    }
    const updatedMembership = {
      ...membership,
      role,
      updatedAt: new Date().toISOString(),
    };
    data.memberships[membershipIndex] = updatedMembership;
    await this.persist(data);
    const user = data.users.find((candidate) => candidate.id === updatedMembership.userId);
    if (!user) {
      throw new Error('Organization user was not found');
    }
    return {
      ...user,
      membershipId: updatedMembership.id,
      tenantId: updatedMembership.tenantId,
      organizationId: updatedMembership.organizationId,
      role: updatedMembership.role,
      permissions: getRolePermissions(updatedMembership.role),
    };
  }

  private async get(): Promise<LocalOrganizationData> {
    if (this.cache) {
      return this.cache;
    }

    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = LocalOrganizationDataSchema.parse(JSON.parse(raw));
      if (parsed.users.length === 0 || parsed.memberships.length === 0) {
        const defaults = createDefaultOrganizationData();
        this.cache = {
          ...parsed,
          users: defaults.users,
          memberships: defaults.memberships,
        };
        await this.persist(this.cache);
        return this.cache;
      }
      this.cache = parsed;
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
    users: [
      {
        id: DEFAULT_USER_ID,
        email: 'agency-admin@example.local',
        displayName: 'Agency Admin',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: DEFAULT_INSURER_USER_ID,
        email: 'insurer-auditor@example.local',
        displayName: 'Insurer Auditor',
        createdAt: now,
        updatedAt: now,
      },
    ],
    memberships: [
      {
        id: DEFAULT_MEMBERSHIP_ID,
        tenantId: DEFAULT_TENANT_ID,
        organizationId: DEFAULT_ORGANIZATION_ID,
        userId: DEFAULT_USER_ID,
        role: 'agency_admin',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: DEFAULT_INSURER_MEMBERSHIP_ID,
        tenantId: DEFAULT_TENANT_ID,
        organizationId: DEFAULT_PARENT_ORGANIZATION_ID,
        userId: DEFAULT_INSURER_USER_ID,
        role: 'auditor',
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}

function defaultUserDataPath(): string {
  return process.env.SALES_TALK_USER_DATA_PATH ?? app?.getPath?.('userData') ?? process.cwd();
}
