import { basename, extname } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type {
  AudioSttJob,
  AudioSttJobStatus,
  CloudAudioUploadProcessResult,
  CloudflareConnectionStatus,
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
  if (token) {
    await (input.fetch ?? fetch)(`${resolveApiUrl(input.apiUrl)}/v1/auth/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
  }
  await (input.deleteSessionToken ?? (() => secretStore.delete('cloudflare_session_token')))();
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
    errorMessage,
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
  return value === 'queued' || value === 'running' || value === 'completed' || value === 'failed'
    ? value
    : null;
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
