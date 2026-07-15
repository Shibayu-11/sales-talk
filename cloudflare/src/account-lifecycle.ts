import {
  createActionToken,
  createPasswordCredential,
  createSessionToken,
  hashActionToken,
  type PasswordCredential,
} from './auth';
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
} from '@cloudflare/workers-types';

export type MembershipStatus = 'active' | 'invited' | 'disabled';
export type OrganizationRole = 'insurer_admin' | 'agency_admin' | 'manager' | 'agent' | 'auditor';
export type ActionTokenType = 'invite' | 'password_reset';

export interface RequestContext {
  tenantId: string;
  organizationId: string;
  userId: string;
  membershipId: string;
  role: OrganizationRole;
}

export interface AuthenticatedContext extends RequestContext {
  sessionVersion: number;
}

export interface AccountGateRow {
  membership_status: MembershipStatus;
  must_reset_password: number;
}

export interface CloudOrganizationUser {
  id: string;
  email: string;
  displayName: string;
  membershipId: string;
  tenantId: string;
  organizationId: string;
  organizationName: string;
  organizationType: string;
  role: OrganizationRole;
  status: MembershipStatus;
  hasCredential: boolean;
  mustResetPassword: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CloudOrganization {
  id: string;
  tenantId: string;
  parentOrganizationId: string | null;
  type: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface ActionTokenIssueResult {
  type: ActionTokenType;
  token: string;
  expiresAt: string;
  membershipId: string;
  userId: string;
  organizationId: string;
}

export interface SessionIssueResult {
  token: string;
  expiresAt: string;
  context: RequestContext;
}

export interface InvitationInput {
  email: string;
  displayName?: string | undefined;
  role: OrganizationRole;
  organizationId?: string | undefined;
}

export interface TokenPasswordInput {
  token: string;
  password: string;
  displayName?: string | undefined;
}

const INVITE_TTL_MS = 72 * 60 * 60 * 1_000;
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1_000;
const ADMIN_ROLES = new Set<OrganizationRole>(['insurer_admin', 'agency_admin']);

export class AccountLifecycleError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function assertLoginAccountAllowed(row: AccountGateRow): void {
  if (row.membership_status !== 'active') {
    throw new AccountLifecycleError(403, 'organization_membership_not_active');
  }
  if (row.must_reset_password !== 0) {
    throw new AccountLifecycleError(403, 'password_reset_required');
  }
}

export function assertSessionAccountAllowed(row: AccountGateRow): void {
  if (row.membership_status !== 'active') {
    throw new AccountLifecycleError(403, 'organization_membership_not_active');
  }
  if (row.must_reset_password !== 0) {
    throw new AccountLifecycleError(403, 'password_reset_required');
  }
}

export function assertAdminCanManageOrganization(input: {
  actorRole: OrganizationRole;
  actorOrganizationId: string;
  targetOrganizationId: string;
  assignedRole?: OrganizationRole | undefined;
}): void {
  if (input.actorRole === 'insurer_admin') {
    return;
  }
  if (input.actorRole === 'agency_admin') {
    if (input.targetOrganizationId !== input.actorOrganizationId) {
      throw new AccountLifecycleError(403, 'organization_scope_forbidden');
    }
    if (input.assignedRole === 'insurer_admin') {
      throw new AccountLifecycleError(403, 'cannot_assign_insurer_admin');
    }
    return;
  }
  throw new AccountLifecycleError(403, 'organization_admin_required');
}

export function assertMembershipStatusChangeAllowed(input: {
  actor: RequestContext;
  target: {
    membershipId: string;
    organizationId: string;
    userId: string;
    role: OrganizationRole;
    status: MembershipStatus;
  };
  nextStatus: 'active' | 'disabled';
}): void {
  assertAdminCanManageOrganization({
    actorRole: input.actor.role,
    actorOrganizationId: input.actor.organizationId,
    targetOrganizationId: input.target.organizationId,
  });
  if (
    input.nextStatus === 'disabled' &&
    input.target.userId === input.actor.userId &&
    input.target.membershipId === input.actor.membershipId
  ) {
    throw new AccountLifecycleError(409, 'cannot_disable_self');
  }
  if (input.nextStatus === 'active' && input.target.status === 'invited') {
    throw new AccountLifecycleError(409, 'invitation_acceptance_required');
  }
}

export function assertD1MutationChanged(
  result: D1Result<unknown> | undefined,
  error: string,
): void {
  if (!result || result.meta.changes !== 1) {
    throw new AccountLifecycleError(409, error);
  }
}

export function assertActionTokenClaimChanged(result: D1Result<unknown> | undefined): void {
  assertD1MutationChanged(result, 'action_token_consumption_failed');
}

export async function listManageableOrganizations(
  database: D1Database,
  context: RequestContext,
): Promise<CloudOrganization[]> {
  assertAdminCanManageOrganization({
    actorRole: context.role,
    actorOrganizationId: context.organizationId,
    targetOrganizationId: context.organizationId,
  });
  const insurerAdmin = context.role === 'insurer_admin';
  const result = await database
    .prepare(
      `SELECT
        id,
        tenant_id,
        parent_organization_id,
        type,
        name,
        created_at,
        updated_at
       FROM organizations
       WHERE tenant_id = ? AND (? = 1 OR id = ?)
       ORDER BY type ASC, name ASC`,
    )
    .bind(context.tenantId, insurerAdmin ? 1 : 0, context.organizationId)
    .all<CloudOrganizationRow>();
  return result.results.map(mapCloudOrganization);
}

export async function listOrganizationUsers(
  database: D1Database,
  context: RequestContext,
): Promise<CloudOrganizationUser[]> {
  assertAdminCanManageOrganization({
    actorRole: context.role,
    actorOrganizationId: context.organizationId,
    targetOrganizationId: context.organizationId,
  });
  const insurerAdmin = context.role === 'insurer_admin';
  const result = await database
    .prepare(
      `SELECT
        u.id,
        u.email,
        u.display_name AS displayName,
        m.id AS membershipId,
        m.tenant_id AS tenantId,
        m.organization_id AS organizationId,
        o.name AS organizationName,
        o.type AS organizationType,
        m.role,
        m.status,
        CASE WHEN c.user_id IS NULL THEN 0 ELSE 1 END AS hasCredential,
        COALESCE(c.must_reset_password, 0) AS mustResetPassword,
        u.created_at AS createdAt,
        m.updated_at AS updatedAt
       FROM organization_memberships m
       JOIN users u ON u.id = m.user_id
       JOIN organizations o ON o.id = m.organization_id
       LEFT JOIN auth_credentials c ON c.user_id = u.id
       WHERE m.tenant_id = ? AND (? = 1 OR m.organization_id = ?)
       ORDER BY o.name ASC, u.email ASC`,
    )
    .bind(context.tenantId, insurerAdmin ? 1 : 0, context.organizationId)
    .all<CloudOrganizationUserRow>();
  return result.results.map(mapCloudOrganizationUser);
}

export async function createInvitation(
  database: D1Database,
  context: RequestContext,
  input: InvitationInput,
  now = new Date(),
): Promise<ActionTokenIssueResult> {
  const targetOrganizationId = input.organizationId ?? context.organizationId;
  const targetOrganization = await findOrganization(database, context.tenantId, targetOrganizationId);
  assertAdminCanManageOrganization({
    actorRole: context.role,
    actorOrganizationId: context.organizationId,
    targetOrganizationId: targetOrganization.id,
    assignedRole: input.role,
  });

  const email = normalizeEmail(input.email);
  const timestamp = now.toISOString();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS).toISOString();
  const existingUser = await database
    .prepare('SELECT id, display_name FROM users WHERE lower(email) = lower(?)')
    .bind(email)
    .first<{ id: string; display_name: string }>();
  const userId = existingUser?.id ?? crypto.randomUUID();
  const displayName = normalizeDisplayName(input.displayName) ?? existingUser?.display_name ?? email;
  const existingMembership = existingUser
    ? await database
        .prepare(
          `SELECT
            m.id,
            m.tenant_id,
            m.organization_id,
            m.status,
            CASE WHEN c.user_id IS NULL THEN 0 ELSE 1 END AS has_credential
           FROM organization_memberships m
           LEFT JOIN auth_credentials c ON c.user_id = m.user_id
           WHERE m.user_id = ?`,
        )
        .bind(userId)
        .first<ExistingMembershipRow>()
    : null;

  if (
    existingUser &&
    (!existingMembership ||
      existingMembership.tenant_id !== context.tenantId ||
      existingMembership.organization_id !== targetOrganization.id)
  ) {
    throw new AccountLifecycleError(409, 'email_already_registered');
  }

  if (existingMembership?.status === 'active') {
    throw new AccountLifecycleError(409, 'membership_already_active');
  }
  if (existingMembership?.status === 'disabled') {
    throw new AccountLifecycleError(409, 'membership_disabled');
  }
  if (existingMembership?.has_credential === 1) {
    throw new AccountLifecycleError(409, 'credential_already_configured');
  }

  const membershipId = existingMembership?.id ?? crypto.randomUUID();
  const actionToken = await createActionToken();
  const tokenId = crypto.randomUUID();
  const issueRequestId = crypto.randomUUID();
  const audit = await createLifecycleAuditStatement(database, {
    scope: { tenantId: context.tenantId, organizationId: targetOrganization.id },
    actor: userAuditActor(context),
    action: 'organization.invitation_created',
    targetType: 'organization_membership',
    targetId: membershipId,
    metadata: {
      targetUserId: userId,
      targetOrganizationId: targetOrganization.id,
      role: input.role,
      status: 'invited',
      tokenType: 'invite',
      tokenId,
      tokenExpiresAt: expiresAt,
    },
    createdAt: timestamp,
  });

  const statements: D1PreparedStatement[] = [];
  if (existingUser) {
    statements.push(
      database
        .prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?')
        .bind(displayName, timestamp, userId),
    );
  } else {
    statements.push(
      database
        .prepare(
          'INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        )
        .bind(userId, email, displayName, timestamp, timestamp),
    );
  }
  if (existingMembership) {
    statements.push(
      database
        .prepare(
          `UPDATE organization_memberships
           SET role = ?, status = 'invited', updated_at = ?
           WHERE id = ?`,
        )
        .bind(input.role, timestamp, membershipId),
    );
  } else {
    statements.push(
      database
        .prepare(
          `INSERT INTO organization_memberships (
            id, tenant_id, organization_id, user_id, role, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'invited', ?, ?)`,
        )
        .bind(
          membershipId,
          context.tenantId,
          targetOrganization.id,
          userId,
          input.role,
          timestamp,
          timestamp,
        ),
    );
  }
  statements.push(
    database
      .prepare(
        `UPDATE auth_action_tokens
         SET consumed_at = ?, consumed_by_request_id = ?, updated_at = ?
         WHERE membership_id = ? AND type = 'invite' AND consumed_at IS NULL`,
      )
      .bind(timestamp, issueRequestId, timestamp, membershipId),
    database
      .prepare(
        `INSERT INTO auth_action_tokens (
          id, type, token_hash, tenant_id, organization_id, user_id, membership_id,
          expires_at, consumed_at, consumed_by_request_id,
          created_by_user_id, created_by_membership_id, created_at, updated_at
        ) VALUES (?, 'invite', ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
      )
      .bind(
        tokenId,
        actionToken.tokenHash,
        context.tenantId,
        targetOrganization.id,
        userId,
        membershipId,
        expiresAt,
        context.userId,
        context.membershipId,
        timestamp,
        timestamp,
      ),
    audit,
  );
  await database.batch(statements);
  return {
    type: 'invite',
    token: actionToken.token,
    expiresAt,
    membershipId,
    userId,
    organizationId: targetOrganization.id,
  };
}

export async function acceptInvitation(
  database: D1Database,
  input: TokenPasswordInput,
  signingKey: string,
  now = new Date(),
): Promise<SessionIssueResult> {
  const tokenHash = await hashActionToken(input.token);
  const row = await findActionToken(database, 'invite', tokenHash);
  assertUsableActionToken(row, now);
  if (row.membership_status !== 'invited') {
    throw new AccountLifecycleError(409, 'invitation_not_pending');
  }
  if (row.has_credential === 1) {
    throw new AccountLifecycleError(409, 'credential_already_configured');
  }

  const timestamp = now.toISOString();
  const claimRequestId = crypto.randomUUID();
  const credential = await createPasswordCredential(input.password);
  const displayName = normalizeDisplayName(input.displayName) ?? row.display_name;
  const audit = await createConditionalLifecycleAuditStatement(
    database,
    {
      scope: { tenantId: row.tenant_id, organizationId: row.organization_id },
      actor: actionTokenAuditActor(),
      action: 'organization.invitation_accepted',
      targetType: 'organization_membership',
      targetId: row.membership_id,
      metadata: {
        targetUserId: row.user_id,
        targetOrganizationId: row.organization_id,
        role: row.role,
        status: 'active',
        tokenType: 'invite',
        tokenId: row.token_id,
        tokenClaimRequestId: claimRequestId,
        issuedByUserId: row.created_by_user_id,
        issuedByMembershipId: row.created_by_membership_id,
      },
      createdAt: timestamp,
    },
    'SELECT 1 FROM auth_action_tokens WHERE token_hash = ? AND consumed_by_request_id = ?',
    [tokenHash, claimRequestId],
  );
  const results = await database.batch([
    consumeActionTokenStatement(database, tokenHash, 'invite', timestamp, claimRequestId),
    database
      .prepare(
        `UPDATE users
         SET display_name = ?, updated_at = ?
         WHERE id = ?
           AND EXISTS (
             SELECT 1 FROM auth_action_tokens
             WHERE token_hash = ? AND consumed_by_request_id = ?
           )`,
      )
      .bind(displayName, timestamp, row.user_id, tokenHash, claimRequestId),
    insertCredentialStatement(database, row.user_id, credential, timestamp, tokenHash, claimRequestId),
    database
      .prepare(
        `UPDATE organization_memberships
         SET status = 'active', updated_at = ?
         WHERE id = ? AND status = 'invited'
           AND EXISTS (
             SELECT 1 FROM auth_action_tokens
             WHERE token_hash = ? AND consumed_by_request_id = ?
           )`,
      )
      .bind(timestamp, row.membership_id, tokenHash, claimRequestId),
    audit,
  ]);
  assertActionTokenClaimChanged(results[0]);
  assertD1MutationChanged(results[1], 'user_update_failed');
  assertD1MutationChanged(results[2], 'credential_creation_failed');
  assertD1MutationChanged(results[3], 'membership_activation_failed');
  assertD1MutationChanged(results[4], 'audit_log_insert_failed');

  const context: RequestContext = {
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    userId: row.user_id,
    membershipId: row.membership_id,
    role: row.role,
  };
  const session = await createSessionToken(
    {
      userId: context.userId,
      tenantId: context.tenantId,
      organizationId: context.organizationId,
      membershipId: context.membershipId,
      sessionVersion: 1,
    },
    signingKey,
    now,
  );
  return { ...session, context };
}

export async function issuePasswordReset(
  database: D1Database,
  context: RequestContext,
  membershipId: string,
  now = new Date(),
): Promise<ActionTokenIssueResult> {
  const target = await findMembershipForAdmin(database, context, membershipId);
  assertAdminCanManageOrganization({
    actorRole: context.role,
    actorOrganizationId: context.organizationId,
    targetOrganizationId: target.organization_id,
  });
  if (target.status !== 'active') {
    throw new AccountLifecycleError(409, 'membership_not_active');
  }
  if (target.has_credential !== 1) {
    throw new AccountLifecycleError(409, 'credential_not_configured');
  }

  const actionToken = await createActionToken();
  const tokenId = crypto.randomUUID();
  const issueRequestId = crypto.randomUUID();
  const timestamp = now.toISOString();
  const expiresAt = new Date(now.getTime() + PASSWORD_RESET_TTL_MS).toISOString();
  const audit = await createLifecycleAuditStatement(database, {
    scope: { tenantId: target.tenant_id, organizationId: target.organization_id },
    actor: userAuditActor(context),
    action: 'organization.password_reset_issued',
    targetType: 'organization_membership',
    targetId: target.membership_id,
    metadata: {
      targetUserId: target.user_id,
      targetOrganizationId: target.organization_id,
      tokenType: 'password_reset',
      tokenId,
      tokenExpiresAt: expiresAt,
      sessionInvalidated: true,
      mustResetPassword: true,
    },
    createdAt: timestamp,
  });
  const results = await database.batch([
    database
      .prepare(
        `UPDATE auth_action_tokens
         SET consumed_at = ?, consumed_by_request_id = ?, updated_at = ?
         WHERE membership_id = ? AND type = 'password_reset' AND consumed_at IS NULL`,
      )
      .bind(timestamp, issueRequestId, timestamp, target.membership_id),
    database
      .prepare(
        `UPDATE auth_credentials
         SET must_reset_password = 1, session_version = session_version + 1, updated_at = ?
         WHERE user_id = ?`,
      )
      .bind(timestamp, target.user_id),
    database
      .prepare(
        `INSERT INTO auth_action_tokens (
          id, type, token_hash, tenant_id, organization_id, user_id, membership_id,
          expires_at, consumed_at, consumed_by_request_id,
          created_by_user_id, created_by_membership_id, created_at, updated_at
        ) VALUES (?, 'password_reset', ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
      )
      .bind(
        tokenId,
        actionToken.tokenHash,
        target.tenant_id,
        target.organization_id,
        target.user_id,
        target.membership_id,
        expiresAt,
        context.userId,
        context.membershipId,
        timestamp,
        timestamp,
      ),
    audit,
  ]);
  assertD1MutationChanged(results[1], 'password_reset_flag_update_failed');
  assertD1MutationChanged(results[2], 'password_reset_token_insert_failed');
  assertD1MutationChanged(results[3], 'audit_log_insert_failed');
  return {
    type: 'password_reset',
    token: actionToken.token,
    expiresAt,
    membershipId: target.membership_id,
    userId: target.user_id,
    organizationId: target.organization_id,
  };
}

export async function completePasswordReset(
  database: D1Database,
  input: TokenPasswordInput,
  signingKey: string,
  now = new Date(),
): Promise<SessionIssueResult> {
  const tokenHash = await hashActionToken(input.token);
  const row = await findActionToken(database, 'password_reset', tokenHash);
  assertUsableActionToken(row, now);
  if (row.membership_status !== 'active') {
    throw new AccountLifecycleError(403, 'organization_membership_not_active');
  }
  if (row.must_reset_password !== 1) {
    throw new AccountLifecycleError(409, 'password_reset_not_required');
  }

  const timestamp = now.toISOString();
  const claimRequestId = crypto.randomUUID();
  const credential = await createPasswordCredential(input.password);
  const nextSessionVersion = row.session_version + 1;
  const audit = await createConditionalLifecycleAuditStatement(
    database,
    {
      scope: { tenantId: row.tenant_id, organizationId: row.organization_id },
      actor: actionTokenAuditActor(),
      action: 'organization.password_reset_completed',
      targetType: 'organization_membership',
      targetId: row.membership_id,
      metadata: {
        targetUserId: row.user_id,
        targetOrganizationId: row.organization_id,
        tokenType: 'password_reset',
        tokenId: row.token_id,
        tokenClaimRequestId: claimRequestId,
        issuedByUserId: row.created_by_user_id,
        issuedByMembershipId: row.created_by_membership_id,
        sessionVersion: nextSessionVersion,
      },
      createdAt: timestamp,
    },
    'SELECT 1 FROM auth_action_tokens WHERE token_hash = ? AND consumed_by_request_id = ?',
    [tokenHash, claimRequestId],
  );
  const results = await database.batch([
    consumeActionTokenStatement(database, tokenHash, 'password_reset', timestamp, claimRequestId),
    database
      .prepare(
        `UPDATE auth_credentials
         SET password_hash = ?, salt = ?, iterations = ?, algorithm = ?, password_updated_at = ?,
             login_failed_count = 0, locked_until = NULL, must_reset_password = 0,
             session_version = ?, updated_at = ?
         WHERE user_id = ? AND must_reset_password = 1 AND session_version = ?
           AND EXISTS (
             SELECT 1 FROM auth_action_tokens
             WHERE token_hash = ? AND consumed_by_request_id = ?
           )`,
      )
      .bind(
        credential.passwordHash,
        credential.salt,
        credential.iterations,
        credential.algorithm,
        timestamp,
        nextSessionVersion,
        timestamp,
        row.user_id,
        row.session_version,
        tokenHash,
        claimRequestId,
      ),
    audit,
  ]);
  assertActionTokenClaimChanged(results[0]);
  assertD1MutationChanged(results[1], 'credential_rotation_failed');
  assertD1MutationChanged(results[2], 'audit_log_insert_failed');

  const context: RequestContext = {
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    userId: row.user_id,
    membershipId: row.membership_id,
    role: row.role,
  };
  const session = await createSessionToken(
    {
      userId: context.userId,
      tenantId: context.tenantId,
      organizationId: context.organizationId,
      membershipId: context.membershipId,
      sessionVersion: nextSessionVersion,
    },
    signingKey,
    now,
  );
  return { ...session, context };
}

export async function setMembershipStatus(
  database: D1Database,
  context: RequestContext,
  membershipId: string,
  nextStatus: 'active' | 'disabled',
  now = new Date(),
): Promise<CloudOrganizationUser> {
  const target = await findMembershipForAdmin(database, context, membershipId);
  assertMembershipStatusChangeAllowed({
    actor: context,
    target: {
      membershipId: target.membership_id,
      organizationId: target.organization_id,
      userId: target.user_id,
      role: target.role,
      status: target.status,
    },
    nextStatus,
  });

  const timestamp = now.toISOString();
  const statusMutationRequestId = crypto.randomUUID();
  const statusMutationExistsSql = `
    SELECT 1 FROM organization_memberships
    WHERE id = ? AND status = ? AND status_changed_by_request_id = ?
  `;
  const audit = await createConditionalLifecycleAuditStatement(
    database,
    {
      scope: { tenantId: target.tenant_id, organizationId: target.organization_id },
      actor: userAuditActor(context),
      action: 'organization.membership_status_updated',
      targetType: 'organization_membership',
      targetId: target.membership_id,
      metadata: {
        targetUserId: target.user_id,
        targetOrganizationId: target.organization_id,
        previousStatus: target.status,
        nextStatus,
        statusMutationRequestId,
        sessionInvalidated: nextStatus === 'disabled',
        outstandingTokensConsumed: nextStatus === 'disabled',
        mustResetPasswordCleared: nextStatus === 'disabled' && target.has_credential === 1,
      },
      createdAt: timestamp,
    },
    statusMutationExistsSql,
    [target.membership_id, nextStatus, statusMutationRequestId],
  );
  const statements = [
    database
      .prepare(
        `UPDATE organization_memberships
         SET status = ?, updated_at = ?, status_changed_by_request_id = ?
         WHERE id = ? AND tenant_id = ? AND organization_id = ? AND user_id = ? AND status = ?
           AND (
             ? != 'disabled'
             OR role NOT IN ('insurer_admin', 'agency_admin')
             OR status != 'active'
             OR (
               SELECT COUNT(*)
               FROM organization_memberships
               WHERE tenant_id = ? AND organization_id = ? AND status = 'active'
                 AND role IN ('insurer_admin', 'agency_admin')
             ) > 1
           )`,
      )
      .bind(
        nextStatus,
        timestamp,
        statusMutationRequestId,
        target.membership_id,
        target.tenant_id,
        target.organization_id,
        target.user_id,
        target.status,
        nextStatus,
        target.tenant_id,
        target.organization_id,
      ),
  ];
  if (nextStatus === 'disabled') {
    statements.push(
      database
        .prepare(
          `UPDATE auth_action_tokens
           SET consumed_at = ?, consumed_by_request_id = ?, updated_at = ?
           WHERE consumed_at IS NULL
             AND type IN ('invite', 'password_reset')
             AND (membership_id = ? OR user_id = ?)
             AND EXISTS (${statusMutationExistsSql})`,
        )
        .bind(
          timestamp,
          statusMutationRequestId,
          timestamp,
          target.membership_id,
          target.user_id,
          target.membership_id,
          nextStatus,
          statusMutationRequestId,
        ),
    );
    if (target.has_credential === 1) {
      statements.push(
        database
          .prepare(
            `UPDATE auth_credentials
             SET session_version = session_version + 1, must_reset_password = 0, updated_at = ?
             WHERE user_id = ?
               AND EXISTS (${statusMutationExistsSql})`,
          )
          .bind(
            timestamp,
            target.user_id,
            target.membership_id,
            nextStatus,
            statusMutationRequestId,
          ),
      );
    }
  }
  statements.push(audit);
  const results = await database.batch(statements);
  if (!results[0] || results[0].meta.changes !== 1) {
    if (
      nextStatus === 'disabled' &&
      target.status === 'active' &&
      ADMIN_ROLES.has(target.role)
    ) {
      throw new AccountLifecycleError(409, 'cannot_disable_last_active_admin');
    }
    throw new AccountLifecycleError(409, 'membership_status_update_conflict');
  }
  const credentialResultIndex = nextStatus === 'disabled' && target.has_credential === 1 ? 2 : -1;
  if (credentialResultIndex !== -1) {
    assertD1MutationChanged(results[credentialResultIndex], 'session_invalidation_failed');
  }
  assertD1MutationChanged(results[results.length - 1], 'audit_log_insert_failed');
  const refreshed = await findMembershipForAdmin(database, context, membershipId);
  return mapMembershipRow(refreshed);
}

interface CloudOrganizationUserRow {
  id: string;
  email: string;
  displayName: string;
  membershipId: string;
  tenantId: string;
  organizationId: string;
  organizationName: string;
  organizationType: string;
  role: OrganizationRole;
  status: MembershipStatus;
  hasCredential: number;
  mustResetPassword: number;
  createdAt: string;
  updatedAt: string;
}

interface CloudOrganizationRow {
  id: string;
  tenant_id: string;
  parent_organization_id: string | null;
  type: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface OrganizationRow {
  id: string;
  tenant_id: string;
  type: string;
}

interface ExistingMembershipRow {
  id: string;
  tenant_id: string;
  organization_id: string;
  status: MembershipStatus;
  has_credential: number;
}

interface MembershipAdminRow {
  id: string;
  email: string;
  display_name: string;
  membership_id: string;
  tenant_id: string;
  organization_id: string;
  organization_name: string;
  organization_type: string;
  user_id: string;
  role: OrganizationRole;
  status: MembershipStatus;
  has_credential: number;
  must_reset_password: number;
  created_at: string;
  updated_at: string;
}

interface ActionTokenRow {
  token_id: string;
  type: ActionTokenType;
  tenant_id: string;
  organization_id: string;
  user_id: string;
  membership_id: string;
  role: OrganizationRole;
  membership_status: MembershipStatus;
  display_name: string;
  expires_at: string;
  consumed_at: string | null;
  created_by_user_id: string | null;
  created_by_membership_id: string | null;
  has_credential: number;
  must_reset_password: number;
  session_version: number;
}

type AuditActor =
  | { type: 'user'; userId: string; membershipId: string }
  | { type: 'system' }
  | { type: 'action_token' };

interface AuditInput {
  scope: { tenantId: string; organizationId: string };
  actor: AuditActor;
  action: string;
  targetType: string;
  targetId: string;
  metadata: Record<string, string | number | boolean | null>;
  createdAt: string;
}

interface AuditChainHead {
  previousHash: string | null;
  nextSequence: number;
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!email.includes('@') || email.length > 320) {
    throw new AccountLifecycleError(400, 'invalid_email');
  }
  return email;
}

function normalizeDisplayName(value: string | undefined): string | undefined {
  const displayName = value?.trim();
  if (!displayName) {
    return undefined;
  }
  if (displayName.length > 120) {
    throw new AccountLifecycleError(400, 'invalid_display_name');
  }
  return displayName;
}

async function findOrganization(
  database: D1Database,
  tenantId: string,
  organizationId: string,
): Promise<OrganizationRow> {
  const organization = await database
    .prepare('SELECT id, tenant_id, type FROM organizations WHERE id = ? AND tenant_id = ?')
    .bind(organizationId, tenantId)
    .first<OrganizationRow>();
  if (!organization) {
    throw new AccountLifecycleError(404, 'organization_not_found');
  }
  return organization;
}

async function findMembershipForAdmin(
  database: D1Database,
  context: RequestContext,
  membershipId: string,
): Promise<MembershipAdminRow> {
  const insurerAdmin = context.role === 'insurer_admin';
  const row = await database
    .prepare(
      `SELECT
        u.id,
        u.email,
        u.display_name,
        m.id AS membership_id,
        m.tenant_id,
        m.organization_id,
        o.name AS organization_name,
        o.type AS organization_type,
        m.user_id,
        m.role,
        m.status,
        CASE WHEN c.user_id IS NULL THEN 0 ELSE 1 END AS has_credential,
        COALESCE(c.must_reset_password, 0) AS must_reset_password,
        u.created_at,
        m.updated_at
       FROM organization_memberships m
       JOIN users u ON u.id = m.user_id
       JOIN organizations o ON o.id = m.organization_id
       LEFT JOIN auth_credentials c ON c.user_id = u.id
       WHERE m.id = ? AND m.tenant_id = ? AND (? = 1 OR m.organization_id = ?)`,
    )
    .bind(membershipId, context.tenantId, insurerAdmin ? 1 : 0, context.organizationId)
    .first<MembershipAdminRow>();
  if (!row) {
    throw new AccountLifecycleError(404, 'membership_not_found');
  }
  return row;
}

async function findActionToken(
  database: D1Database,
  type: ActionTokenType,
  tokenHash: string,
): Promise<ActionTokenRow | null> {
  return database
    .prepare(
      `SELECT
        t.id AS token_id,
        t.type,
        t.tenant_id,
        t.organization_id,
        t.user_id,
        t.membership_id,
        m.role,
        m.status AS membership_status,
        u.display_name,
        t.expires_at,
        t.consumed_at,
        t.created_by_user_id,
        t.created_by_membership_id,
        CASE WHEN c.user_id IS NULL THEN 0 ELSE 1 END AS has_credential,
        COALESCE(c.must_reset_password, 0) AS must_reset_password,
        COALESCE(c.session_version, 1) AS session_version
       FROM auth_action_tokens t
       JOIN organization_memberships m ON m.id = t.membership_id
       JOIN users u ON u.id = t.user_id
       LEFT JOIN auth_credentials c ON c.user_id = t.user_id
       WHERE t.type = ? AND t.token_hash = ?`,
    )
    .bind(type, tokenHash)
    .first<ActionTokenRow>();
}

function assertUsableActionToken(row: ActionTokenRow | null, now: Date): asserts row is ActionTokenRow {
  if (!row) {
    throw new AccountLifecycleError(401, 'invalid_action_token');
  }
  if (row.consumed_at) {
    throw new AccountLifecycleError(401, 'action_token_consumed');
  }
  if (Date.parse(row.expires_at) <= now.getTime()) {
    throw new AccountLifecycleError(401, 'action_token_expired');
  }
}

function consumeActionTokenStatement(
  database: D1Database,
  tokenHash: string,
  type: ActionTokenType,
  timestamp: string,
  claimRequestId: string,
): D1PreparedStatement {
  return database
    .prepare(
      `UPDATE auth_action_tokens
       SET consumed_at = ?, consumed_by_request_id = ?, updated_at = ?
       WHERE token_hash = ? AND type = ? AND consumed_at IS NULL AND expires_at > ?`,
    )
    .bind(timestamp, claimRequestId, timestamp, tokenHash, type, timestamp);
}

function insertCredentialStatement(
  database: D1Database,
  userId: string,
  credential: PasswordCredential,
  timestamp: string,
  tokenHash: string,
  claimRequestId: string,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO auth_credentials (
        user_id, password_hash, salt, iterations, algorithm, password_updated_at,
        login_failed_count, locked_until, session_version, must_reset_password, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, 0, NULL, 1, 0, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM auth_action_tokens
        WHERE token_hash = ? AND consumed_by_request_id = ?
      )`,
    )
    .bind(
      userId,
      credential.passwordHash,
      credential.salt,
      credential.iterations,
      credential.algorithm,
      timestamp,
      timestamp,
      timestamp,
      tokenHash,
      claimRequestId,
    );
}

async function createLifecycleAuditStatement(
  database: D1Database,
  input: AuditInput,
): Promise<D1PreparedStatement> {
  const head = await latestAuditChainHead(database, input.scope.tenantId);
  const id = crypto.randomUUID();
  const hash = await calculateAuditHash({
    ...input,
    id,
    sequence: head.nextSequence,
    previousHash: head.previousHash,
  });
  return database
    .prepare(
      `INSERT INTO audit_logs (
        id, tenant_id, organization_id, actor_type, actor_user_id, actor_membership_id,
        action, target_type, target_id, metadata_json, previous_hash, hash, sequence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.scope.tenantId,
      input.scope.organizationId,
      input.actor.type,
      actorUserId(input.actor),
      actorMembershipId(input.actor),
      input.action,
      input.targetType,
      input.targetId,
      JSON.stringify(input.metadata),
      head.previousHash,
      hash,
      head.nextSequence,
      input.createdAt,
    );
}

async function createConditionalLifecycleAuditStatement(
  database: D1Database,
  input: AuditInput,
  existsSql: string,
  existsBindings: Array<string | number | null>,
): Promise<D1PreparedStatement> {
  const head = await latestAuditChainHead(database, input.scope.tenantId);
  const id = crypto.randomUUID();
  const hash = await calculateAuditHash({
    ...input,
    id,
    sequence: head.nextSequence,
    previousHash: head.previousHash,
  });
  return database
    .prepare(
      `INSERT INTO audit_logs (
        id, tenant_id, organization_id, actor_type, actor_user_id, actor_membership_id,
        action, target_type, target_id, metadata_json, previous_hash, hash, sequence, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (${existsSql})`,
    )
    .bind(
      id,
      input.scope.tenantId,
      input.scope.organizationId,
      input.actor.type,
      actorUserId(input.actor),
      actorMembershipId(input.actor),
      input.action,
      input.targetType,
      input.targetId,
      JSON.stringify(input.metadata),
      head.previousHash,
      hash,
      head.nextSequence,
      input.createdAt,
      ...existsBindings,
    );
}

async function latestAuditChainHead(
  database: D1Database,
  tenantId: string,
): Promise<AuditChainHead> {
  const sequenced = await database
    .prepare(
      `SELECT sequence, hash
       FROM audit_logs
       WHERE tenant_id = ? AND sequence IS NOT NULL
       ORDER BY sequence DESC
       LIMIT 1`,
    )
    .bind(tenantId)
    .first<{ sequence: number; hash: string }>();
  if (sequenced) {
    return { previousHash: sequenced.hash, nextSequence: sequenced.sequence + 1 };
  }
  const unsequenced = await database
    .prepare(
      `SELECT hash
       FROM audit_logs
       WHERE tenant_id = ? AND sequence IS NULL
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    )
    .bind(tenantId)
    .first<{ hash: string }>();
  return { previousHash: unsequenced?.hash ?? null, nextSequence: 1 };
}

async function calculateAuditHash(input: AuditInput & {
  id: string;
  sequence: number;
  previousHash: string | null;
}): Promise<string> {
  const payload = {
    id: input.id,
    sequence: input.sequence,
    tenantId: input.scope.tenantId,
    organizationId: input.scope.organizationId,
    actorType: input.actor.type,
    actorUserId: actorUserId(input.actor),
    actorMembershipId: actorMembershipId(input.actor),
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    metadata: input.metadata,
    previousHash: input.previousHash,
    createdAt: input.createdAt,
  };
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function userAuditActor(context: RequestContext): AuditActor {
  return { type: 'user', userId: context.userId, membershipId: context.membershipId };
}

function actionTokenAuditActor(): AuditActor {
  return { type: 'action_token' };
}

function actorUserId(actor: AuditActor): string | null {
  return actor.type === 'user' ? actor.userId : null;
}

function actorMembershipId(actor: AuditActor): string | null {
  return actor.type === 'user' ? actor.membershipId : null;
}

function mapCloudOrganizationUser(row: CloudOrganizationUserRow): CloudOrganizationUser {
  return {
    ...row,
    hasCredential: row.hasCredential === 1,
    mustResetPassword: row.mustResetPassword === 1,
  };
}

function mapCloudOrganization(row: CloudOrganizationRow): CloudOrganization {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    parentOrganizationId: row.parent_organization_id,
    type: row.type,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMembershipRow(row: MembershipAdminRow): CloudOrganizationUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    membershipId: row.membership_id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    organizationType: row.organization_type,
    role: row.role,
    status: row.status,
    hasCredential: row.has_credential === 1,
    mustResetPassword: row.must_reset_password === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
