import type { OrganizationPermission, OrganizationRole } from './types';

const ROLE_PERMISSIONS: Record<OrganizationRole, OrganizationPermission[]> = {
  insurer_admin: [
    'recording:start',
    'calls:read',
    'reviews:manage',
    'rules:manage',
    'rules:approve',
    'organization:manage',
  ],
  agency_admin: [
    'recording:start',
    'calls:read',
    'reviews:manage',
    'rules:manage',
    'rules:approve',
    'organization:manage',
  ],
  manager: ['recording:start', 'calls:read', 'reviews:manage'],
  agent: ['recording:start', 'calls:read'],
  auditor: ['calls:read'],
};

export function getRolePermissions(role: OrganizationRole): OrganizationPermission[] {
  return [...ROLE_PERMISSIONS[role]];
}
