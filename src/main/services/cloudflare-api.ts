import { basename, extname } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type {
  AudioSttJob,
  AudioSttJobStatus,
  CloudActionTokenResult,
  CloudAudioUploadProcessResult,
  CloudflareConnectionStatus,
  CloudOrganization,
  CloudOrganizationUser,
  MembershipStatus,
  OrganizationRole,
  ProductId,
} from '@shared/types';
import { secretStore } from './secrets';

const DEFAULT_API_URL = 'https://sales-talk-api.lively-violet-0704.workers.dev';
const DEFAULT_STT_POLL_INTERVAL_MS = 1_500;
const DEFAULT_STT_POLL_TIMEOUT_MS = 120_000;

interface CloudflareApiOptions {
  fetch?: typeof fetch | undefined;
  apiUrl?: string | undefined;
  getSessionToken?: (() => Promise<string | null>) | undefined;
  getBootstrapToken?: (() => Promise<string | null>) | undefined;
  saveSessionToken?: ((token: string) => Promise<void>) | undefined;
  deleteSessionToken?: (() => Promise<void>) | undefined;
}

interface CloudAudioUploadOptions extends CloudflareApiOptions {
  pollIntervalMs?: number | undefined;
  pollTimeoutMs?: number | undefined;
}

export async function getCloudflareConnectionStatus(
  input: CloudflareApiOptions = {},
): Promise<CloudflareConnectionStatus> {
  const request = input.fetch ?? fetch;
  const apiUrl = resolveApiUrl(input.apiUrl);
  try {
    const healthResponse = await request(`${apiUrl}/health`);
    if (!healthResponse.ok) {
      return connectionStatus(apiUrl, false, false, `health_${healthResponse.status}`);
    }
    const token = await (
      input.getSessionToken ?? (() => secretStore.get('cloudflare_session_token'))
    )();
    if (!token) {
      return connectionStatus(apiUrl, true, false, 'session_not_configured');
    }
    const contextResponse = await request(`${apiUrl}/v1/context`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return connectionStatus(
      apiUrl,
      true,
      contextResponse.ok,
      contextResponse.ok ? null : `context_${contextResponse.status}`,
    );
  } catch (error) {
    return connectionStatus(
      apiUrl,
      false,
      false,
      error instanceof Error ? error.message : 'cloudflare_connection_failed',
    );
  }
}

export async function bootstrapCloudflareCredential(
  credentials: { email: string; password: string },
  input: CloudflareApiOptions = {},
): Promise<CloudflareConnectionStatus> {
  const request = input.fetch ?? fetch;
  const apiUrl = resolveApiUrl(input.apiUrl);
  const bootstrapToken = await (
    input.getBootstrapToken ?? (() => secretStore.get('cloudflare_api_token'))
  )();
  if (!bootstrapToken) {
    return connectionStatus(apiUrl, true, false, 'bootstrap_token_not_configured');
  }
  const response = await request(`${apiUrl}/v1/auth/bootstrap`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bootstrapToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(credentials),
  });
  if (!response.ok) {
    return connectionStatus(apiUrl, true, false, await responseError(response, 'bootstrap_failed'));
  }
  return loginCloudflare(credentials, input);
}

export async function loginCloudflare(
  credentials: { email: string; password: string },
  input: CloudflareApiOptions = {},
): Promise<CloudflareConnectionStatus> {
  const request = input.fetch ?? fetch;
  const apiUrl = resolveApiUrl(input.apiUrl);
  const response = await request(`${apiUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  if (!response.ok) {
    return connectionStatus(apiUrl, true, false, await responseError(response, 'login_failed'));
  }
  const token = readToken(await response.json());
  if (!token) {
    return connectionStatus(apiUrl, true, false, 'invalid_login_response');
  }
  await (input.saveSessionToken ?? ((value) => secretStore.set('cloudflare_session_token', value)))(
    token,
  );
  return connectionStatus(apiUrl, true, true, null);
}

export async function logoutCloudflare(
  input: CloudflareApiOptions = {},
): Promise<CloudflareConnectionStatus> {
  const token = await (
    input.getSessionToken ?? (() => secretStore.get('cloudflare_session_token'))
  )();
  try {
    if (token) {
      await (input.fetch ?? fetch)(`${resolveApiUrl(input.apiUrl)}/v1/auth/logout`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
    }
  } finally {
    await (input.deleteSessionToken ?? (() => secretStore.delete('cloudflare_session_token')))();
  }
  return connectionStatus(resolveApiUrl(input.apiUrl), true, false, 'session_not_configured');
}

export async function changeCloudflarePassword(
  password: string,
  input: CloudflareApiOptions = {},
): Promise<CloudflareConnectionStatus> {
  const apiUrl = resolveApiUrl(input.apiUrl);
  const token = await (
    input.getSessionToken ?? (() => secretStore.get('cloudflare_session_token'))
  )();
  if (!token) {
    return connectionStatus(apiUrl, true, false, 'session_not_configured');
  }
  const response = await (input.fetch ?? fetch)(`${apiUrl}/v1/auth/change-password`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ password }),
  });
  if (!response.ok) {
    return connectionStatus(
      apiUrl,
      true,
      false,
      await responseError(response, 'password_change_failed'),
    );
  }
  const nextToken = readToken(await response.json());
  if (!nextToken) {
    return connectionStatus(apiUrl, true, false, 'invalid_password_change_response');
  }
  await (input.saveSessionToken ?? ((value) => secretStore.set('cloudflare_session_token', value)))(
    nextToken,
  );
  return connectionStatus(apiUrl, true, true, null);
}

export async function acceptCloudflareInvitation(
  input: { token: string; password: string; displayName?: string | undefined },
  options: CloudflareApiOptions = {},
): Promise<CloudflareConnectionStatus> {
  return completeCloudflareTokenPasswordAction('/v1/auth/invitations/accept', input, options);
}

export async function completeCloudflarePasswordReset(
  input: { token: string; password: string },
  options: CloudflareApiOptions = {},
): Promise<CloudflareConnectionStatus> {
  return completeCloudflareTokenPasswordAction('/v1/auth/password-resets/complete', input, options);
}

export async function listCloudflareOrganizationUsers(
  options: CloudflareApiOptions = {},
): Promise<CloudOrganizationUser[]> {
  const response = await authenticatedCloudflareRequest('/v1/organization/users', options);
  if (!response.ok) {
    throw new Error(await responseError(response, 'cloud_users_fetch_failed'));
  }
  const body = await response.json();
  if (!Array.isArray(body)) {
    throw new Error('invalid_cloud_users_response');
  }
  return body.map((entry) => {
    const user = readCloudOrganizationUser(entry);
    if (!user) {
      throw new Error('invalid_cloud_user_response');
    }
    return user;
  });
}

export async function listCloudflareOrganizations(
  options: CloudflareApiOptions = {},
): Promise<CloudOrganization[]> {
  const response = await authenticatedCloudflareRequest('/v1/organizations', options);
  if (!response.ok) {
    throw new Error(await responseError(response, 'cloud_organizations_fetch_failed'));
  }
  const body = await response.json();
  if (!Array.isArray(body)) {
    throw new Error('invalid_cloud_organizations_response');
  }
  return body.map((entry) => {
    const organization = readCloudOrganization(entry);
    if (!organization) {
      throw new Error('invalid_cloud_organization_response');
    }
    return organization;
  });
}

export async function createCloudflareInvitation(
  input: {
    email: string;
    displayName?: string | undefined;
    role: OrganizationRole;
    organizationId?: string | undefined;
  },
  options: CloudflareApiOptions = {},
): Promise<CloudActionTokenResult> {
  const response = await authenticatedCloudflareRequest('/v1/organization/invitations', options, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(await responseError(response, 'invitation_create_failed'));
  }
  const result = readCloudActionTokenResult(await response.json());
  if (!result) {
    throw new Error('invalid_invitation_response');
  }
  return result;
}

export async function issueCloudflarePasswordReset(
  membershipId: string,
  options: CloudflareApiOptions = {},
): Promise<CloudActionTokenResult> {
  const response = await authenticatedCloudflareRequest('/v1/organization/password-resets', options, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ membershipId }),
  });
  if (!response.ok) {
    throw new Error(await responseError(response, 'password_reset_issue_failed'));
  }
  const result = readCloudActionTokenResult(await response.json());
  if (!result) {
    throw new Error('invalid_password_reset_response');
  }
  return result;
}

export async function setCloudflareMembershipStatus(
  membershipId: string,
  status: Exclude<MembershipStatus, 'invited'>,
  options: CloudflareApiOptions = {},
): Promise<CloudOrganizationUser> {
  const response = await authenticatedCloudflareRequest(
    `/v1/organization/memberships/${encodeURIComponent(membershipId)}/status`,
    options,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
    },
  );
  if (!response.ok) {
    throw new Error(await responseError(response, 'membership_status_update_failed'));
  }
  const user = readCloudOrganizationUser(await response.json());
  if (!user) {
    throw new Error('invalid_membership_status_response');
  }
  return user;
}

export async function uploadAudioToCloudAndProcess(
  input: { filePath: string; productId: ProductId },
  options: CloudAudioUploadOptions = {},
): Promise<CloudAudioUploadProcessResult> {
  const request = options.fetch ?? fetch;
  const apiUrl = resolveApiUrl(options.apiUrl);
  const token = await (
    options.getSessionToken ?? (() => secretStore.get('cloudflare_session_token'))
  )();
  if (!token) {
    throw new Error('cloudflare_session_not_configured');
  }

  const fileStat = await stat(input.filePath);
  if (!fileStat.isFile()) {
    throw new Error('selected_audio_path_is_not_file');
  }

  const fileName = basename(input.filePath);
  const mimeType = mimeTypeForFile(fileName);
  const uploadResponse = await request(`${apiUrl}/v1/audio-upload-urls`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      fileName,
      mimeType,
      sizeBytes: fileStat.size,
      productId: input.productId,
    }),
  });
  if (!uploadResponse.ok) {
    throw new Error(await responseError(uploadResponse, 'audio_upload_url_failed'));
  }

  const uploadTarget = readUploadUrlResponse(await uploadResponse.json());
  if (!uploadTarget) {
    throw new Error('invalid_audio_upload_url_response');
  }

  const fileBytes = await readFile(input.filePath);
  const putResponse = await request(uploadTarget.uploadUrl, {
    method: uploadTarget.method,
    headers: {
      ...uploadTarget.headers,
      'content-type': mimeType,
      'content-length': String(fileStat.size),
    },
    body: fileBytes,
  });
  if (!putResponse.ok) {
    throw new Error(await responseError(putResponse, 'audio_upload_failed'));
  }

  const queued = readQueuedUploadResponse(await putResponse.json());
  if (!queued) {
    throw new Error('invalid_audio_upload_response');
  }

  const job = await waitForCloudSttJob(queued.sttJobId, {
    ...options,
    apiUrl,
    fetch: request,
    getSessionToken: async () => token,
  });
  const transcriptCount = await fetchTranscriptCount(queued.callId, {
    ...options,
    apiUrl,
    fetch: request,
    getSessionToken: async () => token,
  });

  return {
    callId: queued.callId,
    audioAssetId: queued.audioAssetId,
    sttJobId: queued.sttJobId,
    status: job.status,
    job,
    transcriptCount,
  };
}

async function waitForCloudSttJob(
  jobId: string,
  options: CloudAudioUploadOptions,
): Promise<AudioSttJob> {
  const request = options.fetch ?? fetch;
  const apiUrl = resolveApiUrl(options.apiUrl);
  const token = await (
    options.getSessionToken ?? (() => secretStore.get('cloudflare_session_token'))
  )();
  if (!token) {
    throw new Error('cloudflare_session_not_configured');
  }

  const startedAt = Date.now();
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_STT_POLL_INTERVAL_MS;
  const pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_STT_POLL_TIMEOUT_MS;
  let latestJob: AudioSttJob | null = null;

  while (Date.now() - startedAt <= pollTimeoutMs) {
    const response = await request(`${apiUrl}/v1/stt-jobs/${jobId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(await responseError(response, 'stt_job_fetch_failed'));
    }
    const job = readCloudSttJob(await response.json());
    if (!job) {
      throw new Error('invalid_stt_job_response');
    }
    latestJob = job;
    if (job.status === 'completed' || job.status === 'failed') {
      return job;
    }
    await sleep(pollIntervalMs);
  }

  if (latestJob) {
    return latestJob;
  }
  throw new Error('stt_job_poll_timeout');
}

async function fetchTranscriptCount(
  callId: string,
  options: CloudflareApiOptions,
): Promise<number> {
  const request = options.fetch ?? fetch;
  const token = await (
    options.getSessionToken ?? (() => secretStore.get('cloudflare_session_token'))
  )();
  if (!token) {
    throw new Error('cloudflare_session_not_configured');
  }
  const response = await request(`${resolveApiUrl(options.apiUrl)}/v1/calls/${callId}/transcripts`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    return 0;
  }
  const body = await response.json();
  return Array.isArray(body) ? body.length : 0;
}

async function completeCloudflareTokenPasswordAction(
  path: string,
  input: { token: string; password: string; displayName?: string | undefined },
  options: CloudflareApiOptions,
): Promise<CloudflareConnectionStatus> {
  const request = options.fetch ?? fetch;
  const apiUrl = resolveApiUrl(options.apiUrl);
  const response = await request(`${apiUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    return connectionStatus(
      apiUrl,
      true,
      false,
      await responseError(response, 'token_password_action_failed'),
    );
  }
  const token = readToken(await response.json());
  if (!token) {
    return connectionStatus(apiUrl, true, false, 'invalid_token_password_action_response');
  }
  await (options.saveSessionToken ?? ((value) => secretStore.set('cloudflare_session_token', value)))(
    token,
  );
  return connectionStatus(apiUrl, true, true, null);
}

async function authenticatedCloudflareRequest(
  path: string,
  options: CloudflareApiOptions,
  init: RequestInit = {},
): Promise<Response> {
  const token = await (
    options.getSessionToken ?? (() => secretStore.get('cloudflare_session_token'))
  )();
  if (!token) {
    throw new Error('cloudflare_session_not_configured');
  }
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  return (options.fetch ?? fetch)(`${resolveApiUrl(options.apiUrl)}${path}`, {
    ...init,
    headers,
  });
}

function resolveApiUrl(apiUrl?: string): string {
  return apiUrl ?? process.env.CLOUDFLARE_API_URL ?? DEFAULT_API_URL;
}

function connectionStatus(
  apiUrl: string,
  healthy: boolean,
  authenticated: boolean,
  error: string | null,
): CloudflareConnectionStatus {
  return { apiUrl, healthy, authenticated, error };
}

function readToken(value: unknown): string | null {
  if (!isRecord(value) || typeof value.token !== 'string' || value.token.length === 0) {
    return null;
  }
  return value.token;
}

function readCloudActionTokenResult(value: unknown): CloudActionTokenResult | null {
  if (!isRecord(value)) {
    return null;
  }
  const explicitMode = value.mode === 'manual_beta' || value.mode === 'email' ? value.mode : null;
  const legacyManual = value.mode === undefined && value.deliveryId === undefined;
  const mode = explicitMode ?? (legacyManual ? 'manual_beta' : null);
  const type = value.type === 'invite' || value.type === 'password_reset' ? value.type : null;
  const expiresAt = readString(value.expiresAt);
  const membershipId = readString(value.membershipId);
  const userId = readString(value.userId);
  const organizationId = readString(value.organizationId);
  const deliveryId = readString(value.deliveryId);
  if (!mode || !type || !expiresAt || !membershipId || !userId || !organizationId) {
    return null;
  }
  if (mode === 'manual_beta') {
    const token = readString(value.token);
    if (!token) {
      return null;
    }
    return {
      mode,
      type,
      token,
      expiresAt,
      membershipId,
      userId,
      organizationId,
      ...(deliveryId ? { deliveryId } : {}),
    };
  }
  if (
    !deliveryId ||
    value.status !== 'accepted' ||
    !isRecord(value.recipient) ||
    typeof value.recipient.emailMasked !== 'string' ||
    typeof value.trackingDegraded !== 'boolean'
  ) {
    return null;
  }
  const providerMessageId = readString(value.providerMessageId);
  return {
    mode,
    type,
    status: value.status,
    expiresAt,
    membershipId,
    userId,
    organizationId,
    deliveryId,
    recipient: { emailMasked: value.recipient.emailMasked },
    providerMessageId: providerMessageId ?? undefined,
    trackingDegraded: value.trackingDegraded,
  };
}

function readCloudOrganizationUser(value: unknown): CloudOrganizationUser | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = readString(value.id);
  const email = readString(value.email);
  const displayName = readString(value.displayName);
  const membershipId = readString(value.membershipId);
  const tenantId = readString(value.tenantId);
  const organizationId = readString(value.organizationId);
  const organizationName = readString(value.organizationName);
  const organizationType = readString(value.organizationType);
  const role = readOrganizationRole(value.role);
  const status = readMembershipStatus(value.status);
  const createdAt = readString(value.createdAt);
  const updatedAt = readString(value.updatedAt);
  if (
    !id ||
    !email ||
    !displayName ||
    !membershipId ||
    !tenantId ||
    !organizationId ||
    !organizationName ||
    !organizationType ||
    !role ||
    !status ||
    typeof value.hasCredential !== 'boolean' ||
    typeof value.mustResetPassword !== 'boolean' ||
    !createdAt ||
    !updatedAt
  ) {
    return null;
  }
  return {
    id,
    email,
    displayName,
    membershipId,
    tenantId,
    organizationId,
    organizationName,
    organizationType,
    role,
    status,
    hasCredential: value.hasCredential,
    mustResetPassword: value.mustResetPassword,
    createdAt,
    updatedAt,
  };
}

function readCloudOrganization(value: unknown): CloudOrganization | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = readString(value.id);
  const tenantId = readString(value.tenantId);
  const parentOrganizationId = readNullableString(value.parentOrganizationId);
  const type = readOrganizationType(value.type);
  const name = readString(value.name);
  const createdAt = readString(value.createdAt);
  const updatedAt = readString(value.updatedAt);
  if (!id || !tenantId || !type || !name || !createdAt || !updatedAt) {
    return null;
  }
  return {
    id,
    tenantId,
    parentOrganizationId,
    type,
    name,
    createdAt,
    updatedAt,
  };
}

interface UploadUrlResponse {
  uploadUrl: string;
  method: 'PUT';
  headers: Record<string, string>;
}

function readUploadUrlResponse(value: unknown): UploadUrlResponse | null {
  if (
    !isRecord(value) ||
    typeof value.uploadUrl !== 'string' ||
    value.uploadUrl.length === 0 ||
    value.method !== 'PUT' ||
    !isStringRecord(value.headers)
  ) {
    return null;
  }
  return {
    uploadUrl: value.uploadUrl,
    method: value.method,
    headers: value.headers,
  };
}

function readQueuedUploadResponse(
  value: unknown,
): { callId: string; audioAssetId: string; sttJobId: string } | null {
  if (
    !isRecord(value) ||
    typeof value.callId !== 'string' ||
    typeof value.audioAssetId !== 'string' ||
    typeof value.sttJobId !== 'string'
  ) {
    return null;
  }
  return {
    callId: value.callId,
    audioAssetId: value.audioAssetId,
    sttJobId: value.sttJobId,
  };
}

function readCloudSttJob(value: unknown): AudioSttJob | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = readString(value.id);
  const callId = readString(value.callId) ?? readString(value.call_id);
  const audioAssetId = readString(value.audioAssetId) ?? readString(value.audio_asset_id);
  const provider = readString(value.provider);
  const status = readAudioSttJobStatus(value.status);
  const createdAt = readString(value.createdAt) ?? readString(value.created_at);
  const updatedAt = readString(value.updatedAt) ?? readString(value.updated_at);
  const errorMessage = readNullableString(value.errorMessage ?? value.error_message);
  const progressPercent =
    typeof value.progressPercent === 'number'
      ? value.progressPercent
      : status === 'completed'
        ? 100
        : status === 'running'
          ? 10
          : 0;
  const attempt =
    typeof value.attempt === 'number' && Number.isInteger(value.attempt) ? value.attempt : 1;
  if (
    !id ||
    !callId ||
    !audioAssetId ||
    provider !== 'deepgram' ||
    !status ||
    !createdAt ||
    !updatedAt
  ) {
    return null;
  }
  return {
    id,
    callId,
    audioAssetId,
    provider,
    status,
    runToken: null,
    progressPercent,
    attempt,
    retryReason: readNullableString(value.retryReason ?? value.retry_reason),
    transcriptRevisionId: readNullableString(
      value.transcriptRevisionId ?? value.transcript_revision_id,
    ),
    errorMessage,
    startedAt: readNullableString(value.startedAt ?? value.started_at),
    completedAt: readNullableString(value.completedAt ?? value.completed_at),
    createdAt,
    updatedAt,
  };
}

async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json();
    return isRecord(body) && typeof body.error === 'string'
      ? body.error
      : `${fallback}_${response.status}`;
  } catch {
    return `${fallback}_${response.status}`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string')
  );
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : readString(value);
}

function readAudioSttJobStatus(value: unknown): AudioSttJobStatus | null {
  return value === 'queued' ||
    value === 'running' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
    ? value
    : null;
}

function readOrganizationRole(value: unknown): OrganizationRole | null {
  return value === 'insurer_admin' ||
    value === 'agency_admin' ||
    value === 'manager' ||
    value === 'agent' ||
    value === 'auditor'
    ? value
    : null;
}

function readMembershipStatus(value: unknown): MembershipStatus | null {
  return value === 'active' || value === 'invited' || value === 'disabled' ? value : null;
}

function readOrganizationType(value: unknown): CloudOrganization['type'] | null {
  return value === 'insurer' || value === 'agency' || value === 'internal' ? value : null;
}

function mimeTypeForFile(fileName: string): string {
  switch (extname(fileName).toLowerCase()) {
    case '.m4a':
      return 'audio/mp4';
    case '.mp3':
      return 'audio/mpeg';
    case '.wav':
      return 'audio/wav';
    case '.aac':
      return 'audio/aac';
    case '.mp4':
      return 'video/mp4';
    case '.webm':
      return 'audio/webm';
    default:
      return 'application/octet-stream';
  }
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}
