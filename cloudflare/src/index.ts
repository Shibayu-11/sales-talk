import {
  createPasswordCredential,
  createSessionToken,
  verifyPassword,
  verifySessionToken,
  type PasswordCredential,
  type SessionPayload,
} from './auth';

interface RequestContext {
  tenantId: string;
  organizationId: string;
  userId: string;
  membershipId: string;
  role: string;
}

interface AuthenticatedContext extends RequestContext {
  sessionVersion: number;
}

interface AuditLogInput {
  action: string;
  targetType: string;
  targetId: string;
  metadata: Record<string, string | number | boolean | null>;
  previousHash: string | null;
  hash: string;
  createdAt: string;
}

interface AuthUserRow {
  user_id: string;
  tenant_id: string;
  organization_id: string;
  membership_id: string;
  role: string;
  password_hash: string;
  salt: string;
  iterations: number;
  algorithm: PasswordCredential['algorithm'];
  locked_until: string | null;
  login_failed_count: number;
  session_version: number;
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/health') {
        const database = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
        return json({ ok: database?.ok === 1, service: 'sales-talk-api' });
      }

      if (request.method === 'POST' && url.pathname === '/v1/auth/bootstrap') {
        await assertBootstrapToken(request, env.API_TOKEN);
        await bootstrapCredential(env.DB, parseCredentialInput(await request.json()));
        return json({ ok: true }, 201);
      }
      if (request.method === 'POST' && url.pathname === '/v1/auth/login') {
        return json(
          await login(
            env.DB,
            parseCredentialInput(await request.json()),
            requiredSecret(env.SESSION_SIGNING_KEY, 'session_signing_key_not_configured'),
          ),
        );
      }

      const session = await assertSession(request, env.SESSION_SIGNING_KEY);
      const context = await resolveSessionContext(session, env.DB);

      if (request.method === 'GET' && url.pathname === '/v1/context') {
        return json(publicContext(context));
      }
      if (request.method === 'POST' && url.pathname === '/v1/auth/change-password') {
        return json(
          await changePassword(
            env.DB,
            context,
            parsePasswordInput(await request.json()),
            requiredSecret(env.SESSION_SIGNING_KEY, 'session_signing_key_not_configured'),
          ),
        );
      }
      if (request.method === 'POST' && url.pathname === '/v1/auth/logout') {
        await invalidateSessions(env.DB, context.userId);
        return json({ ok: true });
      }
      if (request.method === 'GET' && url.pathname === '/v1/rule-sets') {
        return json(await listRuleSets(env.DB, context));
      }
      if (request.method === 'GET' && url.pathname === '/v1/audit-logs') {
        return json(await listAuditLogs(env.DB, context));
      }
      if (request.method === 'POST' && url.pathname === '/v1/audit-logs') {
        const input = parseAuditLogInput(await request.json());
        await insertAuditLog(env.DB, context, input);
        return json({ ok: true }, 201);
      }

      return json({ error: 'not_found' }, 404);
    } catch (error) {
      logRequestFailure(error);
      return json({ error: errorMessage(error) }, errorStatus(error));
    }
  },
} satisfies ExportedHandler<Env>;

async function resolveSessionContext(
  session: SessionPayload,
  database: D1Database,
): Promise<AuthenticatedContext> {
  const membership = await database
    .prepare(
      `SELECT m.id, m.role, c.session_version
       FROM organization_memberships m
       JOIN auth_credentials c ON c.user_id = m.user_id
       WHERE m.id = ? AND m.tenant_id = ? AND m.organization_id = ? AND m.user_id = ?`,
    )
    .bind(session.membershipId, session.tenantId, session.organizationId, session.userId)
    .first<{ id: string; role: string; session_version: number }>();
  if (!membership || membership.session_version !== session.sessionVersion) {
    throw new HttpError(403, 'organization_membership_not_found');
  }
  return {
    tenantId: session.tenantId,
    organizationId: session.organizationId,
    userId: session.userId,
    membershipId: membership.id,
    role: membership.role,
    sessionVersion: membership.session_version,
  };
}

async function listRuleSets(database: D1Database, context: RequestContext): Promise<unknown[]> {
  const result = await database
    .prepare(
      `SELECT rs.*
       FROM compliance_rule_sets rs
       LEFT JOIN organizations current_org ON current_org.id = ?
       WHERE rs.tenant_id = ?
         AND (rs.organization_id = ? OR rs.organization_id = current_org.parent_organization_id)
       ORDER BY rs.updated_at DESC`,
    )
    .bind(context.organizationId, context.tenantId, context.organizationId)
    .all();
  return result.results;
}

async function listAuditLogs(database: D1Database, context: RequestContext): Promise<unknown[]> {
  const insurerAdmin = context.role === 'insurer_admin';
  const result = await database
    .prepare(
      `SELECT *
       FROM audit_logs
       WHERE tenant_id = ? AND (? = 1 OR organization_id = ?)
       ORDER BY created_at DESC
       LIMIT 1000`,
    )
    .bind(context.tenantId, insurerAdmin ? 1 : 0, context.organizationId)
    .all();
  return result.results;
}

async function insertAuditLog(
  database: D1Database,
  context: RequestContext,
  input: AuditLogInput,
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO audit_logs (
        id, tenant_id, organization_id, actor_type, actor_user_id, actor_membership_id,
        action, target_type, target_id, metadata_json, previous_hash, hash, created_at
      ) VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      context.tenantId,
      context.organizationId,
      context.userId,
      context.membershipId,
      input.action,
      input.targetType,
      input.targetId,
      JSON.stringify(input.metadata),
      input.previousHash,
      input.hash,
      input.createdAt,
    )
    .run();
}

async function assertBootstrapToken(request: Request, expectedToken: string | undefined): Promise<void> {
  const configuredToken = requiredSecret(expectedToken, 'api_token_not_configured');
  const providedToken = bearerToken(request, 'missing_api_token');
  if (!(await constantTimeEqual(providedToken, configuredToken))) {
    throw new HttpError(401, 'invalid_api_token');
  }
}

async function assertSession(
  request: Request,
  signingKey: string | undefined,
): Promise<SessionPayload> {
  const token = bearerToken(request, 'missing_session');
  const payload = await verifySessionToken(
    token,
    requiredSecret(signingKey, 'session_signing_key_not_configured'),
  );
  if (!payload) {
    throw new HttpError(401, 'invalid_or_expired_session');
  }
  return payload;
}

async function bootstrapCredential(
  database: D1Database,
  input: { email: string; password: string },
): Promise<void> {
  const user = await database
    .prepare('SELECT id FROM users WHERE lower(email) = lower(?)')
    .bind(input.email)
    .first<{ id: string }>();
  if (!user) {
    throw new HttpError(404, 'user_not_found');
  }
  const existing = await database
    .prepare('SELECT user_id FROM auth_credentials WHERE user_id = ?')
    .bind(user.id)
    .first<{ user_id: string }>();
  if (existing) {
    throw new HttpError(409, 'credential_already_configured');
  }
  const credential = await createPasswordCredential(input.password);
  const timestamp = new Date().toISOString();
  await database
    .prepare(
      `INSERT INTO auth_credentials (
        user_id, password_hash, salt, iterations, algorithm, password_updated_at,
        login_failed_count, locked_until, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
    )
    .bind(
      user.id,
      credential.passwordHash,
      credential.salt,
      credential.iterations,
      credential.algorithm,
      timestamp,
      timestamp,
      timestamp,
    )
    .run();
}

async function login(
  database: D1Database,
  input: { email: string; password: string },
  signingKey: string,
): Promise<{ token: string; expiresAt: string; context: RequestContext }> {
  const user = await database
    .prepare(
      `SELECT
        u.id AS user_id,
        m.tenant_id,
        m.organization_id,
        m.id AS membership_id,
        m.role,
        c.password_hash,
        c.salt,
        c.iterations,
        c.algorithm,
        c.locked_until,
        c.login_failed_count,
        c.session_version
      FROM users u
      JOIN auth_credentials c ON c.user_id = u.id
      JOIN organization_memberships m ON m.user_id = u.id
      WHERE lower(u.email) = lower(?)
      ORDER BY m.created_at ASC
      LIMIT 1`,
    )
    .bind(input.email)
    .first<AuthUserRow>();
  if (!user) {
    throw new HttpError(401, 'invalid_credentials');
  }
  if (user.locked_until && Date.parse(user.locked_until) > Date.now()) {
    throw new HttpError(429, 'account_temporarily_locked');
  }
  const valid = await verifyPassword(input.password, {
    passwordHash: user.password_hash,
    salt: user.salt,
    iterations: user.iterations,
    algorithm: user.algorithm,
  });
  if (!valid) {
    await recordFailedLogin(database, user);
    throw new HttpError(401, 'invalid_credentials');
  }
  await database
    .prepare(
      'UPDATE auth_credentials SET login_failed_count = 0, locked_until = NULL, updated_at = ? WHERE user_id = ?',
    )
    .bind(new Date().toISOString(), user.user_id)
    .run();
  const context: RequestContext = {
    tenantId: user.tenant_id,
    organizationId: user.organization_id,
    userId: user.user_id,
    membershipId: user.membership_id,
    role: user.role,
  };
  const session = await createSessionToken(
    {
      userId: context.userId,
      tenantId: context.tenantId,
      organizationId: context.organizationId,
      membershipId: context.membershipId,
      sessionVersion: user.session_version,
    },
    signingKey,
  );
  return { ...session, context };
}

async function changePassword(
  database: D1Database,
  context: AuthenticatedContext,
  password: string,
  signingKey: string,
): Promise<{ token: string; expiresAt: string; context: RequestContext }> {
  const credential = await createPasswordCredential(password);
  const nextSessionVersion = context.sessionVersion + 1;
  const timestamp = new Date().toISOString();
  await database
    .prepare(
      `UPDATE auth_credentials
       SET password_hash = ?, salt = ?, iterations = ?, algorithm = ?, password_updated_at = ?,
           login_failed_count = 0, locked_until = NULL, session_version = ?, updated_at = ?
       WHERE user_id = ?`,
    )
    .bind(
      credential.passwordHash,
      credential.salt,
      credential.iterations,
      credential.algorithm,
      timestamp,
      nextSessionVersion,
      timestamp,
      context.userId,
    )
    .run();
  const session = await createSessionToken(
    {
      userId: context.userId,
      tenantId: context.tenantId,
      organizationId: context.organizationId,
      membershipId: context.membershipId,
      sessionVersion: nextSessionVersion,
    },
    signingKey,
  );
  return { ...session, context: publicContext(context) };
}

async function invalidateSessions(database: D1Database, userId: string): Promise<void> {
  await database
    .prepare(
      'UPDATE auth_credentials SET session_version = session_version + 1, updated_at = ? WHERE user_id = ?',
    )
    .bind(new Date().toISOString(), userId)
    .run();
}

async function recordFailedLogin(database: D1Database, user: AuthUserRow): Promise<void> {
  const failedCount = user.login_failed_count + 1;
  const lockedUntil =
    failedCount >= 5 ? new Date(Date.now() + 15 * 60 * 1_000).toISOString() : null;
  await database
    .prepare(
      'UPDATE auth_credentials SET login_failed_count = ?, locked_until = ?, updated_at = ? WHERE user_id = ?',
    )
    .bind(failedCount, lockedUntil, new Date().toISOString(), user.user_id)
    .run();
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index]! ^ rightBytes[index]!;
  }
  return difference === 0;
}

function parseAuditLogInput(value: unknown): AuditLogInput {
  if (!isRecord(value)) {
    throw new HttpError(400, 'invalid_audit_log');
  }
  const metadata = value.metadata;
  if (
    typeof value.action !== 'string' ||
    typeof value.targetType !== 'string' ||
    typeof value.targetId !== 'string' ||
    !isRecord(metadata) ||
    (value.previousHash !== null && typeof value.previousHash !== 'string') ||
    typeof value.hash !== 'string' ||
    typeof value.createdAt !== 'string'
  ) {
    throw new HttpError(400, 'invalid_audit_log');
  }
  return {
    action: value.action,
    targetType: value.targetType,
    targetId: value.targetId,
    metadata: metadata as AuditLogInput['metadata'],
    previousHash: value.previousHash,
    hash: value.hash,
    createdAt: value.createdAt,
  };
}

function parseCredentialInput(value: unknown): { email: string; password: string } {
  if (
    !isRecord(value) ||
    typeof value.email !== 'string' ||
    !value.email.includes('@') ||
    value.email.length > 320 ||
    typeof value.password !== 'string' ||
    value.password.length < 12 ||
    value.password.length > 200
  ) {
    throw new HttpError(400, 'invalid_credentials_input');
  }
  return { email: value.email.trim().toLowerCase(), password: value.password };
}

function parsePasswordInput(value: unknown): string {
  if (
    !isRecord(value) ||
    typeof value.password !== 'string' ||
    value.password.length < 12 ||
    value.password.length > 200
  ) {
    throw new HttpError(400, 'invalid_password_input');
  }
  return value.password;
}

function bearerToken(request: Request, missingError: string): string {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    throw new HttpError(401, missingError);
  }
  return authorization.slice('Bearer '.length);
}

function requiredSecret(value: string | undefined, error: string): string {
  if (!value) {
    throw new HttpError(503, error);
  }
  return value;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

function publicContext(context: RequestContext): RequestContext {
  return {
    tenantId: context.tenantId,
    organizationId: context.organizationId,
    userId: context.userId,
    membershipId: context.membershipId,
    role: context.role,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'internal_error';
}

function errorStatus(error: unknown): number {
  return error instanceof HttpError ? error.status : 500;
}

function logRequestFailure(error: unknown): void {
  const status = errorStatus(error);
  const payload = JSON.stringify({
    message: status >= 500 ? 'request_failed' : 'request_rejected',
    error: errorMessage(error),
    status,
  });
  if (status >= 500) {
    console.error(payload);
    return;
  }
  console.warn(payload);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
