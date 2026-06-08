import { describe, expect, it, vi } from 'vitest';
import { getCloudflareConnectionStatus } from '../../src/main/services/cloudflare-api';

describe('getCloudflareConnectionStatus', () => {
  it('reports healthy and authenticated Cloudflare API connection', async () => {
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return Response.json(url.endsWith('/health') ? { ok: true } : { role: 'agency_admin' });
    });

    await expect(
      getCloudflareConnectionStatus({
        fetch: request,
        apiUrl: 'https://example.workers.dev',
        getToken: async () => 'token',
      }),
    ).resolves.toEqual({
      apiUrl: 'https://example.workers.dev',
      healthy: true,
      authenticated: true,
      error: null,
    });
  });

  it('reports a healthy Worker when API token is not configured', async () => {
    await expect(
      getCloudflareConnectionStatus({
        fetch: async () => Response.json({ ok: true }),
        apiUrl: 'https://example.workers.dev',
        getToken: async () => null,
      }),
    ).resolves.toMatchObject({
      healthy: true,
      authenticated: false,
      error: 'api_token_not_configured',
    });
  });
});
