import type { CloudflareConnectionStatus } from '@shared/types';
import { secretStore } from './secrets';

const DEFAULT_API_URL = 'https://sales-talk-api.lively-violet-0704.workers.dev';

interface CloudflareApiOptions {
  fetch?: typeof fetch | undefined;
  apiUrl?: string | undefined;
  getSessionToken?: (() => Promise<string | null>) | undefined;
  getBootstrapToken?: (() => Promise<string | null>) | undefined;
  saveSessionToken?: ((token: string) => Promise<void>) | undefined;
  deleteSessionToken?: (() => Promise<void>) | undefined;
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
