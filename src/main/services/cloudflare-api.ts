import {
  DEFAULT_MEMBERSHIP_ID,
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_TENANT_ID,
  DEFAULT_USER_ID,
} from '@shared/organization-constants';
import type { CloudflareConnectionStatus } from '@shared/types';
import { secretStore } from './secrets';

const DEFAULT_API_URL = 'https://sales-talk-api.lively-violet-0704.workers.dev';

export async function getCloudflareConnectionStatus(input: {
  fetch?: typeof fetch | undefined;
  apiUrl?: string | undefined;
  getToken?: (() => Promise<string | null>) | undefined;
} = {}): Promise<CloudflareConnectionStatus> {
  const request = input.fetch ?? fetch;
  const apiUrl = input.apiUrl ?? process.env.CLOUDFLARE_API_URL ?? DEFAULT_API_URL;
  try {
    const healthResponse = await request(`${apiUrl}/health`);
    if (!healthResponse.ok) {
      return { apiUrl, healthy: false, authenticated: false, error: `health_${healthResponse.status}` };
    }
    const token = await (input.getToken ?? (() => secretStore.get('cloudflare_api_token')))();
    if (!token) {
      return { apiUrl, healthy: true, authenticated: false, error: 'api_token_not_configured' };
    }
    const contextResponse = await request(`${apiUrl}/v1/context`, {
      headers: {
        authorization: `Bearer ${token}`,
        'x-tenant-id': DEFAULT_TENANT_ID,
        'x-organization-id': DEFAULT_ORGANIZATION_ID,
        'x-user-id': DEFAULT_USER_ID,
        'x-membership-id': DEFAULT_MEMBERSHIP_ID,
      },
    });
    return {
      apiUrl,
      healthy: true,
      authenticated: contextResponse.ok,
      error: contextResponse.ok ? null : `context_${contextResponse.status}`,
    };
  } catch (error) {
    return {
      apiUrl,
      healthy: false,
      authenticated: false,
      error: error instanceof Error ? error.message : 'cloudflare_connection_failed',
    };
  }
}
