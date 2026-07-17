import {
  createPasswordCredential,
  createSignedPayloadToken,
  createSessionToken,
  verifySignedPayloadToken,
  verifyPassword,
  verifySessionToken,
  type PasswordCredential,
  type SessionPayload,
} from './auth';
import {
  AccountLifecycleError,
  acceptInvitation,
  assertLoginAccountAllowed,
  assertSessionAccountAllowed,
  completePasswordReset,
  createInvitation,
  issuePasswordReset,
  listManageableOrganizations,
  listOrganizationUsers,
  setMembershipStatus,
  assertD1MutationChanged,
  type AuthenticatedContext,
  type MembershipStatus,
  type OrganizationRole,
  type RequestContext,
} from './account-lifecycle';
import {
  AuthEmailDeliveryError,
  assertAuthEmailDeliveryConfigured,
  sendAuthActionEmail,
} from './auth-email';
import { transcribeWithDeepgram, type SttQueueMessage, type TranscriptSegmentInput } from './stt';

interface AudioUploadResult {
  callId: string;
  audioAssetId: string;
  sttJobId: string;
  status: 'queued';
}

interface SignedAudioUploadResult {
  uploadId: string;
  callId: string;
  audioAssetId: string;
  sttJobId: string;
  uploadUrl: string;
  expiresAt: string;
  method: 'PUT';
  headers: {
    'content-type': string;
    'content-length': string;
  };
}

interface AudioUploadMetadata {
  callId: string;
  audioAssetId: string;
  sttJobId: string;
  tenantId: string;
  organizationId: string;
  userId: string;
  r2Key: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  productId: string;
}

interface SignedUploadPayload extends AudioUploadMetadata {
  uploadId: string;
}

interface AuthUserRow {
  user_id: string;
  tenant_id: string;
  organization_id: string;
  membership_id: string;
  role: OrganizationRole;
  membership_status: MembershipStatus;
  password_hash: string;
  salt: string;
  iterations: number;
  algorithm: PasswordCredential['algorithm'];
  locked_until: string | null;
  login_failed_count: number;
  session_version: number;
  must_reset_password: number;
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
      if (request.method === 'POST' && url.pathname === '/v1/auth/invitations/accept') {
        return json(
          await acceptInvitation(
            env.DB,
            parseTokenPasswordInput(await request.json()),
            requiredSecret(env.SESSION_SIGNING_KEY, 'session_signing_key_not_configured'),
          ),
          201,
        );
      }
      if (request.method === 'POST' && url.pathname === '/v1/auth/password-resets/complete') {
        return json(
          await completePasswordReset(
            env.DB,
            parseTokenPasswordInput(await request.json()),
            requiredSecret(env.SESSION_SIGNING_KEY, 'session_signing_key_not_configured'),
          ),
          201,
        );
      }
      if (request.method === 'PUT' && url.pathname.startsWith('/v1/audio-upload-urls/')) {
        return json(
          await consumeSignedAudioUpload(
            request,
            env,
            pathId(url.pathname, '/v1/audio-upload-urls/'),
          ),
          201,
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
      if (request.method === 'GET' && url.pathname === '/v1/organization/users') {
        return json(await listOrganizationUsers(env.DB, context));
      }
      if (request.method === 'GET' && url.pathname === '/v1/organizations') {
        return json(await listManageableOrganizations(env.DB, context));
      }
      if (request.method === 'POST' && url.pathname === '/v1/organization/invitations') {
        const emailEnv = authEmailEnv(env);
        assertAuthEmailDeliveryConfigured(emailEnv);
        const invitation = await createInvitation(
          env.DB,
          context,
          parseInvitationInput(await request.json()),
        );
        return json(
          await sendAuthActionEmail(emailEnv, invitation),
          201,
        );
      }
      if (request.method === 'POST' && url.pathname === '/v1/organization/password-resets') {
        const emailEnv = authEmailEnv(env);
        assertAuthEmailDeliveryConfigured(emailEnv);
        const reset = await issuePasswordReset(
          env.DB,
          context,
          parsePasswordResetInput(await request.json()).membershipId,
        );
        return json(
          await sendAuthActionEmail(emailEnv, reset),
          201,
        );
      }
      const membershipStatusMatch =
        /^\/v1\/organization\/memberships\/([^/]+)\/status$/.exec(url.pathname);
      if (request.method === 'POST' && membershipStatusMatch?.[1]) {
        return json(
          await setMembershipStatus(
            env.DB,
            context,
            decodeURIComponent(membershipStatusMatch[1]),
            parseMembershipStatusInput(await request.json()).status,
          ),
        );
      }
      if (request.method === 'GET' && url.pathname === '/v1/rule-sets') {
        return json(await listRuleSets(env.DB, context));
      }
      if (request.method === 'GET' && url.pathname === '/v1/audit-logs') {
        return json(await listAuditLogs(env.DB, context));
      }
      if (request.method === 'POST' && url.pathname === '/v1/audio-assets') {
        return json(await uploadAudioAsset(request, env, context), 201);
      }
      if (request.method === 'POST' && url.pathname === '/v1/audio-upload-urls') {
        return json(await createSignedAudioUploadUrl(request, env, context, url), 201);
      }
      if (request.method === 'GET' && url.pathname.startsWith('/v1/stt-jobs/')) {
        return json(await getSttJob(env.DB, context, pathId(url.pathname, '/v1/stt-jobs/')));
      }
      if (request.method === 'GET' && url.pathname.startsWith('/v1/calls/')) {
        const match = /^\/v1\/calls\/([^/]+)\/transcripts$/.exec(url.pathname);
        if (match?.[1]) {
          return json(await listTranscriptSegments(env.DB, context, match[1]));
        }
      }

      return json({ error: 'not_found' }, 404);
    } catch (error) {
      logRequestFailure(error);
      return json({ error: errorMessage(error) }, errorStatus(error));
    }
  },

  async queue(batch, env): Promise<void> {
    for (const message of batch.messages) {
      await processSttQueueMessage(env, message.body);
      message.ack();
    }
  },
} satisfies ExportedHandler<Env, SttQueueMessage>;

async function resolveSessionContext(
  session: SessionPayload,
  database: D1Database,
): Promise<AuthenticatedContext> {
  const membership = await database
    .prepare(
      `SELECT m.id, m.role, m.status AS membership_status, c.session_version, c.must_reset_password
       FROM organization_memberships m
       JOIN auth_credentials c ON c.user_id = m.user_id
       WHERE m.id = ? AND m.tenant_id = ? AND m.organization_id = ? AND m.user_id = ?`,
    )
    .bind(session.membershipId, session.tenantId, session.organizationId, session.userId)
    .first<{
      id: string;
      role: OrganizationRole;
      membership_status: MembershipStatus;
      session_version: number;
      must_reset_password: number;
    }>();
  if (!membership || membership.session_version !== session.sessionVersion) {
    throw new HttpError(403, 'organization_membership_not_found');
  }
  assertSessionAccountAllowed(membership);
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
       ORDER BY sequence IS NULL ASC, sequence DESC, created_at DESC, id DESC
       LIMIT 1000`,
    )
    .bind(context.tenantId, insurerAdmin ? 1 : 0, context.organizationId)
    .all();
  return result.results;
}

async function uploadAudioAsset(
  request: Request,
  env: Env,
  context: RequestContext,
): Promise<AudioUploadResult> {
  const contentLength = parseContentLength(request.headers.get('content-length'));
  if (contentLength <= 0) {
    throw new HttpError(400, 'missing_audio_body');
  }
  if (contentLength > 100 * 1024 * 1024) {
    throw new HttpError(413, 'audio_file_too_large');
  }
  if (!request.body) {
    throw new HttpError(400, 'missing_audio_body');
  }

  const timestamp = new Date().toISOString();
  const callId = crypto.randomUUID();
  const audioAssetId = crypto.randomUUID();
  const sttJobId = crypto.randomUUID();
  const fileName = sanitizeFileName(request.headers.get('x-file-name') ?? 'upload.audio');
  const mimeType = request.headers.get('content-type') ?? 'application/octet-stream';
  const productId = request.headers.get('x-product-id') ?? 'real_estate';
  const r2Key = [
    context.tenantId,
    context.organizationId,
    callId,
    `${audioAssetId}-${fileName}`,
  ].join('/');

  await persistAudioUpload(
    env,
    request.body,
    {
      callId,
      audioAssetId,
      sttJobId,
      tenantId: context.tenantId,
      organizationId: context.organizationId,
      userId: context.userId,
      r2Key,
      fileName,
      mimeType,
      sizeBytes: contentLength,
      productId,
    },
    timestamp,
  );
  return { callId, audioAssetId, sttJobId, status: 'queued' };
}

async function createSignedAudioUploadUrl(
  request: Request,
  env: Env,
  context: RequestContext,
  url: URL,
): Promise<SignedAudioUploadResult> {
  const input = parseSignedAudioUploadInput(await request.json());
  const timestamp = new Date().toISOString();
  const uploadId = crypto.randomUUID();
  const callId = crypto.randomUUID();
  const audioAssetId = crypto.randomUUID();
  const sttJobId = crypto.randomUUID();
  const fileName = sanitizeFileName(input.fileName);
  const r2Key = [
    context.tenantId,
    context.organizationId,
    callId,
    `${audioAssetId}-${fileName}`,
  ].join('/');
  const payload: SignedUploadPayload = {
    uploadId,
    callId,
    audioAssetId,
    sttJobId,
    tenantId: context.tenantId,
    organizationId: context.organizationId,
    userId: context.userId,
    r2Key,
    fileName,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    productId: input.productId,
  };
  const signed = await createSignedPayloadToken(
    signedUploadPayloadRecord(payload),
    requiredSecret(env.SESSION_SIGNING_KEY, 'session_signing_key_not_configured'),
    15 * 60,
  );
  await env.DB.prepare(
    `INSERT INTO pending_audio_uploads (
      id, call_id, audio_asset_id, stt_job_id, tenant_id, organization_id, user_id, r2_key,
      file_name, mime_type, size_bytes, product_id, status, expires_at, consumed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?)`,
  )
    .bind(
      uploadId,
      callId,
      audioAssetId,
      sttJobId,
      context.tenantId,
      context.organizationId,
      context.userId,
      r2Key,
      fileName,
      input.mimeType,
      input.sizeBytes,
      input.productId,
      signed.expiresAt,
      timestamp,
      timestamp,
    )
    .run();
  return {
    uploadId,
    callId,
    audioAssetId,
    sttJobId,
    uploadUrl: `${url.origin}/v1/audio-upload-urls/${encodeURIComponent(signed.token)}`,
    expiresAt: signed.expiresAt,
    method: 'PUT',
    headers: {
      'content-type': input.mimeType,
      'content-length': String(input.sizeBytes),
    },
  };
}

async function consumeSignedAudioUpload(
  request: Request,
  env: Env,
  token: string,
): Promise<AudioUploadResult> {
  const payload = await verifySignedPayloadToken(
    decodeURIComponent(token),
    requiredSecret(env.SESSION_SIGNING_KEY, 'session_signing_key_not_configured'),
    parseSignedUploadPayload,
  );
  if (!payload) {
    throw new HttpError(401, 'invalid_or_expired_upload_url');
  }
  const contentLength = parseContentLength(request.headers.get('content-length'));
  if (contentLength !== payload.sizeBytes) {
    throw new HttpError(400, 'audio_size_mismatch');
  }
  if (!request.body) {
    throw new HttpError(400, 'missing_audio_body');
  }
  const pending = await env.DB.prepare(
    `SELECT id, status, expires_at
     FROM pending_audio_uploads
     WHERE id = ? AND tenant_id = ? AND organization_id = ?`,
  )
    .bind(payload.uploadId, payload.tenantId, payload.organizationId)
    .first<{ id: string; status: string; expires_at: string }>();
  if (!pending || pending.status !== 'pending') {
    throw new HttpError(409, 'upload_url_already_consumed');
  }
  if (Date.parse(pending.expires_at) <= Date.now()) {
    await markPendingUpload(env.DB, payload.uploadId, 'expired');
    throw new HttpError(401, 'upload_url_expired');
  }
  const timestamp = new Date().toISOString();
  await persistAudioUpload(env, request.body, payload, timestamp);
  await env.DB.prepare(
    `UPDATE pending_audio_uploads
     SET status = 'consumed', consumed_at = ?, updated_at = ?
     WHERE id = ? AND status = 'pending'`,
  )
    .bind(timestamp, timestamp, payload.uploadId)
    .run();
  return {
    callId: payload.callId,
    audioAssetId: payload.audioAssetId,
    sttJobId: payload.sttJobId,
    status: 'queued',
  };
}

async function persistAudioUpload(
  env: Env,
  body: ReadableStream,
  metadata: AudioUploadMetadata,
  timestamp: string,
): Promise<void> {
  await env.AUDIO_BUCKET.put(metadata.r2Key, body, {
    httpMetadata: { contentType: metadata.mimeType },
    customMetadata: {
      tenantId: metadata.tenantId,
      organizationId: metadata.organizationId,
      callId: metadata.callId,
      audioAssetId: metadata.audioAssetId,
      uploadedByUserId: metadata.userId,
    },
  });
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO calls (
        id, tenant_id, organization_id, source, industry, product_id,
        consent_status, consent_method, consent_captured_at, consent_notice_version,
        status, started_at, ended_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'mobile_recording', 'insurance', ?, 'granted', 'upload_attestation', ?, 'cloud-v1', 'ended', ?, ?, ?, ?)`,
    ).bind(
      metadata.callId,
      metadata.tenantId,
      metadata.organizationId,
      metadata.productId,
      timestamp,
      timestamp,
      timestamp,
      timestamp,
      timestamp,
    ),
    env.DB.prepare(
      `INSERT INTO audio_assets (
        id, call_id, tenant_id, organization_id, r2_key, file_name, mime_type, size_bytes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      metadata.audioAssetId,
      metadata.callId,
      metadata.tenantId,
      metadata.organizationId,
      metadata.r2Key,
      metadata.fileName,
      metadata.mimeType,
      metadata.sizeBytes,
      timestamp,
    ),
    env.DB.prepare(
      `INSERT INTO stt_jobs (
        id, call_id, audio_asset_id, tenant_id, organization_id, provider, status, error_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'deepgram', 'queued', NULL, ?, ?)`,
    ).bind(
      metadata.sttJobId,
      metadata.callId,
      metadata.audioAssetId,
      metadata.tenantId,
      metadata.organizationId,
      timestamp,
      timestamp,
    ),
  ]);
  await env.STT_QUEUE.send({
    jobId: metadata.sttJobId,
    callId: metadata.callId,
    audioAssetId: metadata.audioAssetId,
    r2Key: metadata.r2Key,
    tenantId: metadata.tenantId,
    organizationId: metadata.organizationId,
    mimeType: metadata.mimeType,
  });
}

async function markPendingUpload(
  database: D1Database,
  uploadId: string,
  status: 'expired',
): Promise<void> {
  await database
    .prepare('UPDATE pending_audio_uploads SET status = ?, updated_at = ? WHERE id = ?')
    .bind(status, new Date().toISOString(), uploadId)
    .run();
}

async function getSttJob(
  database: D1Database,
  context: RequestContext,
  jobId: string,
): Promise<unknown> {
  const row = await database
    .prepare(
      `SELECT *
       FROM stt_jobs
       WHERE id = ? AND tenant_id = ? AND organization_id = ?`,
    )
    .bind(jobId, context.tenantId, context.organizationId)
    .first();
  if (!row) {
    throw new HttpError(404, 'stt_job_not_found');
  }
  return row;
}

async function listTranscriptSegments(
  database: D1Database,
  context: RequestContext,
  callId: string,
): Promise<unknown[]> {
  const result = await database
    .prepare(
      `SELECT *
       FROM transcript_segments
       WHERE call_id = ? AND tenant_id = ? AND organization_id = ?
       ORDER BY start_ms ASC`,
    )
    .bind(callId, context.tenantId, context.organizationId)
    .all();
  return result.results;
}

async function processSttQueueMessage(env: Env, message: SttQueueMessage): Promise<void> {
  const timestamp = new Date().toISOString();
  await env.DB.prepare('UPDATE stt_jobs SET status = ?, updated_at = ? WHERE id = ?')
    .bind('running', timestamp, message.jobId)
    .run();
  try {
    const audioObject = await env.AUDIO_BUCKET.get(message.r2Key);
    if (!audioObject) {
      throw new Error('audio_object_not_found');
    }
    const transcripts = await transcribeWithDeepgram({
      apiKey: requiredSecret(env.DEEPGRAM_API_KEY, 'deepgram_api_key_not_configured'),
      audio: await audioObject.arrayBuffer(),
      mimeType: message.mimeType,
    });
    await insertTranscriptSegments(
      env.DB,
      transcripts.map((transcript) => ({
        id: crypto.randomUUID(),
        callId: message.callId,
        tenantId: message.tenantId,
        organizationId: message.organizationId,
        speaker: 'counterpart',
        text: transcript.text,
        isFinal: true,
        startMs: transcript.startMs,
        endMs: transcript.endMs,
        createdAt: new Date().toISOString(),
      })),
    );
    await env.DB.prepare('UPDATE stt_jobs SET status = ?, error_message = NULL, updated_at = ? WHERE id = ?')
      .bind('completed', new Date().toISOString(), message.jobId)
      .run();
  } catch (error) {
    await env.DB.prepare('UPDATE stt_jobs SET status = ?, error_message = ?, updated_at = ? WHERE id = ?')
      .bind('failed', errorMessage(error), new Date().toISOString(), message.jobId)
      .run();
    throw error;
  }
}

async function insertTranscriptSegments(
  database: D1Database,
  transcripts: TranscriptSegmentInput[],
): Promise<void> {
  if (transcripts.length === 0) {
    return;
  }
  await database.batch(
    transcripts.map((transcript) =>
      database
        .prepare(
          `INSERT INTO transcript_segments (
            id, call_id, tenant_id, organization_id, speaker, text, is_final, start_ms, end_ms, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          transcript.id,
          transcript.callId,
          transcript.tenantId,
          transcript.organizationId,
          transcript.speaker,
          transcript.text,
          transcript.isFinal ? 1 : 0,
          transcript.startMs,
          transcript.endMs,
          transcript.createdAt,
        ),
    ),
  );
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
        m.status AS membership_status,
        c.password_hash,
        c.salt,
        c.iterations,
        c.algorithm,
        c.locked_until,
        c.login_failed_count,
        c.session_version,
        c.must_reset_password
      FROM users u
      JOIN auth_credentials c ON c.user_id = u.id
      JOIN organization_memberships m ON m.user_id = u.id
      WHERE lower(u.email) = lower(?)
      ORDER BY CASE WHEN m.status = 'active' THEN 0 ELSE 1 END, m.created_at ASC
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
  assertLoginAccountAllowed(user);
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
  const result = await database
    .prepare(
      `UPDATE auth_credentials
       SET password_hash = ?, salt = ?, iterations = ?, algorithm = ?, password_updated_at = ?,
           login_failed_count = 0, locked_until = NULL,
           session_version = ?, updated_at = ?
       WHERE user_id = ? AND session_version = ? AND must_reset_password = 0`,
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
      context.sessionVersion,
    )
    .run();
  assertD1MutationChanged(result, 'password_change_conflict');
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
  const lockedUntil = new Date(Date.now() + 15 * 60 * 1_000).toISOString();
  await database
    .prepare(
      `UPDATE auth_credentials
       SET login_failed_count = login_failed_count + 1,
           locked_until = CASE WHEN login_failed_count + 1 >= 5 THEN ? ELSE locked_until END,
           updated_at = ?
       WHERE user_id = ?`,
    )
    .bind(lockedUntil, new Date().toISOString(), user.user_id)
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

function parseInvitationInput(value: unknown): {
  email: string;
  displayName?: string | undefined;
  role: OrganizationRole;
  organizationId?: string | undefined;
} {
  if (
    !isRecord(value) ||
    typeof value.email !== 'string' ||
    !value.email.includes('@') ||
    value.email.length > 320 ||
    !isOrganizationRole(value.role) ||
    (value.displayName !== undefined && typeof value.displayName !== 'string') ||
    (value.organizationId !== undefined && typeof value.organizationId !== 'string')
  ) {
    throw new HttpError(400, 'invalid_invitation_input');
  }
  return {
    email: value.email.trim().toLowerCase(),
    displayName: value.displayName?.trim() || undefined,
    role: value.role,
    organizationId: value.organizationId?.trim() || undefined,
  };
}

function parseTokenPasswordInput(value: unknown): {
  token: string;
  password: string;
  displayName?: string | undefined;
} {
  if (
    !isRecord(value) ||
    typeof value.token !== 'string' ||
    value.token.trim().length < 32 ||
    typeof value.password !== 'string' ||
    value.password.length < 12 ||
    value.password.length > 200 ||
    (value.displayName !== undefined && typeof value.displayName !== 'string')
  ) {
    throw new HttpError(400, 'invalid_token_password_input');
  }
  return {
    token: value.token.trim(),
    password: value.password,
    displayName: value.displayName?.trim() || undefined,
  };
}

function parsePasswordResetInput(value: unknown): { membershipId: string } {
  if (!isRecord(value) || typeof value.membershipId !== 'string' || !value.membershipId) {
    throw new HttpError(400, 'invalid_password_reset_input');
  }
  return { membershipId: value.membershipId };
}

function parseMembershipStatusInput(value: unknown): { status: 'active' | 'disabled' } {
  if (
    !isRecord(value) ||
    (value.status !== 'active' && value.status !== 'disabled')
  ) {
    throw new HttpError(400, 'invalid_membership_status_input');
  }
  return { status: value.status };
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

function parseSignedAudioUploadInput(value: unknown): {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  productId: string;
} {
  if (
    !isRecord(value) ||
    typeof value.fileName !== 'string' ||
    value.fileName.trim().length === 0 ||
    typeof value.mimeType !== 'string' ||
    !value.mimeType.startsWith('audio/') ||
    typeof value.sizeBytes !== 'number' ||
    !Number.isInteger(value.sizeBytes) ||
    value.sizeBytes <= 0 ||
    value.sizeBytes > 100 * 1024 * 1024
  ) {
    throw new HttpError(400, 'invalid_audio_upload_input');
  }
  return {
    fileName: value.fileName,
    mimeType: value.mimeType,
    sizeBytes: value.sizeBytes,
    productId: typeof value.productId === 'string' && value.productId ? value.productId : 'real_estate',
  };
}

function parseSignedUploadPayload(value: Record<string, unknown>): SignedUploadPayload | null {
  if (
    typeof value.uploadId !== 'string' ||
    typeof value.callId !== 'string' ||
    typeof value.audioAssetId !== 'string' ||
    typeof value.sttJobId !== 'string' ||
    typeof value.tenantId !== 'string' ||
    typeof value.organizationId !== 'string' ||
    typeof value.userId !== 'string' ||
    typeof value.r2Key !== 'string' ||
    typeof value.fileName !== 'string' ||
    typeof value.mimeType !== 'string' ||
    typeof value.sizeBytes !== 'number' ||
    !Number.isInteger(value.sizeBytes) ||
    typeof value.productId !== 'string'
  ) {
    return null;
  }
  return {
    uploadId: value.uploadId,
    callId: value.callId,
    audioAssetId: value.audioAssetId,
    sttJobId: value.sttJobId,
    tenantId: value.tenantId,
    organizationId: value.organizationId,
    userId: value.userId,
    r2Key: value.r2Key,
    fileName: value.fileName,
    mimeType: value.mimeType,
    sizeBytes: value.sizeBytes,
    productId: value.productId,
  };
}

function signedUploadPayloadRecord(payload: SignedUploadPayload): Record<string, string | number> {
  return {
    uploadId: payload.uploadId,
    callId: payload.callId,
    audioAssetId: payload.audioAssetId,
    sttJobId: payload.sttJobId,
    tenantId: payload.tenantId,
    organizationId: payload.organizationId,
    userId: payload.userId,
    r2Key: payload.r2Key,
    fileName: payload.fileName,
    mimeType: payload.mimeType,
    sizeBytes: payload.sizeBytes,
    productId: payload.productId,
  };
}

function parseContentLength(value: string | null): number {
  if (!value) {
    return 0;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function sanitizeFileName(value: string): string {
  const sanitized = value.replaceAll(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return sanitized || 'upload.audio';
}

function pathId(pathname: string, prefix: string): string {
  const id = pathname.slice(prefix.length);
  if (!id) {
    throw new HttpError(400, 'missing_path_id');
  }
  return id;
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

function authEmailEnv(env: Env): Parameters<typeof sendAuthActionEmail>[0] {
  const extra = env as Env & {
    AUTH_EMAIL_FROM?: string | undefined;
    AUTH_EMAIL_FROM_NAME?: string | undefined;
  };
  return {
    DB: env.DB,
    AUTH_EMAIL: env.AUTH_EMAIL
      ? { send: async (message) => env.AUTH_EMAIL.send(message) }
      : undefined,
    AUTH_EMAIL_DELIVERY_MODE: env.AUTH_EMAIL_DELIVERY_MODE,
    AUTH_EMAIL_FROM: extra.AUTH_EMAIL_FROM,
    AUTH_EMAIL_FROM_NAME: extra.AUTH_EMAIL_FROM_NAME,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOrganizationRole(value: unknown): value is OrganizationRole {
  return (
    value === 'insurer_admin' ||
    value === 'agency_admin' ||
    value === 'manager' ||
    value === 'agent' ||
    value === 'auditor'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'internal_error';
}

function errorStatus(error: unknown): number {
  if (error instanceof AccountLifecycleError) {
    return error.status;
  }
  if (error instanceof AuthEmailDeliveryError) {
    return error.status;
  }
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
