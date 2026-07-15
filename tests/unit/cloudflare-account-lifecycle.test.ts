import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import {
  AccountLifecycleError,
  assertActionTokenClaimChanged,
  assertAdminCanManageOrganization,
  assertD1MutationChanged,
  assertLoginAccountAllowed,
  assertMembershipStatusChangeAllowed,
  assertSessionAccountAllowed,
  setMembershipStatus,
  type RequestContext,
} from '../../cloudflare/src/account-lifecycle';

const agencyAdmin: RequestContext = {
  tenantId: 'tenant-id',
  organizationId: 'agency-org-id',
  userId: 'admin-user-id',
  membershipId: 'admin-membership-id',
  role: 'agency_admin',
};

describe('Cloudflare account lifecycle guards', () => {
  it('allows only admins to manage organization lifecycle actions', () => {
    expect(() =>
      assertAdminCanManageOrganization({
        actorRole: 'agency_admin',
        actorOrganizationId: 'agency-org-id',
        targetOrganizationId: 'agency-org-id',
        assignedRole: 'agent',
      }),
    ).not.toThrow();
    expect(() =>
      assertAdminCanManageOrganization({
        actorRole: 'agency_admin',
        actorOrganizationId: 'agency-org-id',
        targetOrganizationId: 'insurer-org-id',
        assignedRole: 'agent',
      }),
    ).toThrowError(new AccountLifecycleError(403, 'organization_scope_forbidden'));
    expect(() =>
      assertAdminCanManageOrganization({
        actorRole: 'agency_admin',
        actorOrganizationId: 'agency-org-id',
        targetOrganizationId: 'agency-org-id',
        assignedRole: 'insurer_admin',
      }),
    ).toThrowError(new AccountLifecycleError(403, 'cannot_assign_insurer_admin'));
    expect(() =>
      assertAdminCanManageOrganization({
        actorRole: 'manager',
        actorOrganizationId: 'agency-org-id',
        targetOrganizationId: 'agency-org-id',
      }),
    ).toThrowError(new AccountLifecycleError(403, 'organization_admin_required'));
  });

  it('blocks self-disable and invited activation outside acceptance', () => {
    expect(() =>
      assertMembershipStatusChangeAllowed({
        actor: agencyAdmin,
        target: {
          membershipId: 'admin-membership-id',
          organizationId: 'agency-org-id',
          userId: 'admin-user-id',
          role: 'agency_admin',
          status: 'active',
        },
        nextStatus: 'disabled',
      }),
    ).toThrowError(new AccountLifecycleError(409, 'cannot_disable_self'));
    expect(() =>
      assertMembershipStatusChangeAllowed({
        actor: agencyAdmin,
        target: {
          membershipId: 'invited-membership-id',
          organizationId: 'agency-org-id',
          userId: 'invited-user-id',
          role: 'agent',
          status: 'invited',
        },
        nextStatus: 'active',
      }),
    ).toThrowError(new AccountLifecycleError(409, 'invitation_acceptance_required'));
    expect(() =>
      assertMembershipStatusChangeAllowed({
        actor: agencyAdmin,
        target: {
          membershipId: 'agent-membership-id',
          organizationId: 'agency-org-id',
          userId: 'agent-user-id',
          role: 'agent',
          status: 'active',
        },
        nextStatus: 'disabled',
      }),
    ).not.toThrow();
  });

  it('requires D1 CAS mutations to change exactly one row', () => {
    expect(() => assertD1MutationChanged(d1Result(1), 'mutation_failed')).not.toThrow();
    expect(() => assertD1MutationChanged(d1Result(0), 'mutation_failed')).toThrowError(
      new AccountLifecycleError(409, 'mutation_failed'),
    );
    expect(() => assertActionTokenClaimChanged(d1Result(0))).toThrowError(
      new AccountLifecycleError(409, 'action_token_consumption_failed'),
    );
  });

  it('enforces active membership and completed resets for login/session use', () => {
    expect(() =>
      assertLoginAccountAllowed({ membership_status: 'active', must_reset_password: 0 }),
    ).not.toThrow();
    expect(() =>
      assertLoginAccountAllowed({ membership_status: 'disabled', must_reset_password: 0 }),
    ).toThrowError(new AccountLifecycleError(403, 'organization_membership_not_active'));
    expect(() =>
      assertSessionAccountAllowed({ membership_status: 'active', must_reset_password: 1 }),
    ).toThrowError(new AccountLifecycleError(403, 'password_reset_required'));
  });

  it('documents account lifecycle D1 invariants in migration 0007', () => {
    const migration = readFileSync(
      join(process.cwd(), 'cloudflare/migrations/0007_account_lifecycle.sql'),
      'utf8',
    );

    expect(migration).toContain('CREATE UNIQUE INDEX organization_memberships_user_unique_idx');
    expect(migration).toContain('ON organization_memberships(user_id)');
    expect(migration).toContain('status_changed_by_request_id TEXT');
    expect(migration).toContain('consumed_by_request_id TEXT');
    expect(migration).toContain('ADD COLUMN sequence INTEGER');
    expect(migration).toContain('ON audit_logs(tenant_id, sequence)');
  });

  it('clears must-reset password state when disabling a credentialed membership', async () => {
    const fake = new FakeLifecycleDatabase();

    await expect(
      setMembershipStatus(
        fake.asD1Database(),
        agencyAdmin,
        'agent-membership-id',
        'disabled',
        new Date('2026-07-16T00:00:00.000Z'),
      ),
    ).resolves.toMatchObject({
      membershipId: 'agent-membership-id',
      status: 'disabled',
      mustResetPassword: false,
    });

    const credentialUpdate = fake.statements.find(
      (statement) =>
        statement.query.includes('UPDATE auth_credentials') &&
        statement.query.includes('session_version = session_version + 1'),
    );
    expect(credentialUpdate?.query).toContain('must_reset_password = 0');

    const auditInsert = fake.statements.find((statement) =>
      statement.query.includes('INSERT INTO audit_logs'),
    );
    const metadata = JSON.parse(String(auditInsert?.bindings[9] ?? '{}')) as Record<
      string,
      unknown
    >;
    expect(metadata).toMatchObject({
      nextStatus: 'disabled',
      sessionInvalidated: true,
      outstandingTokensConsumed: true,
      mustResetPasswordCleared: true,
    });
  });
});

function d1Result(changes: number): D1Result<unknown> {
  return {
    success: true,
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: 0,
      rows_written: changes,
      last_row_id: 0,
      changed_db: changes > 0,
      changes,
    },
    results: [],
  };
}

interface CapturedStatement {
  query: string;
  bindings: unknown[];
}

class FakeLifecycleDatabase {
  readonly statements: CapturedStatement[] = [];
  private membershipReads = 0;

  asD1Database(): D1Database {
    return {
      prepare: (query: string) => this.prepare(query),
      batch: async (statements: D1PreparedStatement[]) =>
        statements.map((_statement, index) => d1Result(index === 1 ? 0 : 1)),
    } as unknown as D1Database;
  }

  private prepare(query: string): D1PreparedStatement {
    const statement: CapturedStatement = { query, bindings: [] };
    this.statements.push(statement);
    const fakeStatement = {
      bind: (...values: unknown[]) => {
        statement.bindings = values;
        return fakeStatement;
      },
      first: async <T>() => this.first<T>(query),
      all: async <T>() => ({ success: true, meta: d1Result(0).meta, results: [] as T[] }),
      run: async () => d1Result(1),
    };
    return fakeStatement as unknown as D1PreparedStatement;
  }

  private first<T>(query: string): T | null {
    if (query.includes('FROM organization_memberships m')) {
      this.membershipReads += 1;
      return this.membershipRow(this.membershipReads > 1 ? 'disabled' : 'active') as T;
    }
    return null;
  }

  private membershipRow(status: 'active' | 'disabled'): Record<string, string | number> {
    return {
      id: 'agent-user-id',
      email: 'agent@example.local',
      display_name: 'Agent User',
      membership_id: 'agent-membership-id',
      tenant_id: agencyAdmin.tenantId,
      organization_id: agencyAdmin.organizationId,
      organization_name: 'Agency',
      organization_type: 'agency',
      user_id: 'agent-user-id',
      role: 'agent',
      status,
      has_credential: 1,
      must_reset_password: 0,
      created_at: '2026-07-15T00:00:00.000Z',
      updated_at: '2026-07-16T00:00:00.000Z',
    };
  }
}
