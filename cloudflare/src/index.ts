interface RequestContext {
  tenantId: string;
  organizationId: string;
  userId: string;
  membershipId: string;
  role: string;
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

export default {
  async fetch(request, env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/health') {
        const database = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
        return json({ ok: database?.ok === 1, service: 'sales-talk-api' });
      }

      await assertApiToken(request, env.API_TOKEN);
      const context = await resolveRequestContext(request, env.DB);

      if (request.method === 'GET' && url.pathname === '/v1/context') {
        return json(context);
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
      console.error(JSON.stringify({ message: 'request_failed', error: errorMessage(error) }));
      return json({ error: errorMessage(error) }, errorStatus(error));
    }
  },
} satisfies ExportedHandler<Env>;

async function resolveRequestContext(request: Request, database: D1Database): Promise<RequestContext> {
  const tenantId = requiredHeader(request, 'x-tenant-id');
  const organizationId = requiredHeader(request, 'x-organization-id');
  const userId = requiredHeader(request, 'x-user-id');
  const membership = await database
    .prepare(
      `SELECT id, role
       FROM organization_memberships
       WHERE tenant_id = ? AND organization_id = ? AND user_id = ?`,
    )
    .bind(tenantId, organizationId, userId)
    .first<{ id: string; role: string }>();
  if (!membership) {
    throw new HttpError(403, 'organization_membership_not_found');
  }
  return { tenantId, organizationId, userId, membershipId: membership.id, role: membership.role };
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

async function assertApiToken(request: Request, expectedToken: string | undefined): Promise<void> {
  if (!expectedToken) {
    throw new HttpError(503, 'api_token_not_configured');
  }
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    throw new HttpError(401, 'missing_api_token');
  }
  const providedToken = authorization.slice('Bearer '.length);
  if (!(await constantTimeEqual(providedToken, expectedToken))) {
    throw new HttpError(401, 'invalid_api_token');
  }
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

function requiredHeader(request: Request, name: string): string {
  const value = request.headers.get(name);
  if (!value) {
    throw new HttpError(400, `missing_${name}`);
  }
  return value;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
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

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
