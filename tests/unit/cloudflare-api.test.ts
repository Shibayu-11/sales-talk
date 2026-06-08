import { describe, expect, it, vi } from 'vitest';
import {
  bootstrapCloudflareCredential,
  changeCloudflarePassword,
  getCloudflareConnectionStatus,
  loginCloudflare,
  logoutCloudflare,
} from '../../src/main/services/cloudflare-api';

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
        getSessionToken: async () => 'session',
      }),
    ).resolves.toEqual({
      apiUrl: 'https://example.workers.dev',
      healthy: true,
      authenticated: true,
      error: null,
    });
  });

  it('reports a healthy Worker when a session is not configured', async () => {
    await expect(
      getCloudflareConnectionStatus({
        fetch: async () => Response.json({ ok: true }),
        apiUrl: 'https://example.workers.dev',
        getSessionToken: async () => null,
      }),
    ).resolves.toMatchObject({
      healthy: true,
      authenticated: false,
      error: 'session_not_configured',
    });
  });

  it('stores the session returned from login', async () => {
    const saveSessionToken = vi.fn(async () => undefined);

    await expect(
      loginCloudflare(
        { email: 'agency-admin@example.local', password: 'strong-password' },
        {
          apiUrl: 'https://example.workers.dev',
          fetch: async () => Response.json({ token: 'signed-session' }),
          saveSessionToken,
        },
      ),
    ).resolves.toMatchObject({ authenticated: true });
    expect(saveSessionToken).toHaveBeenCalledWith('signed-session');
  });

  it('uses the bootstrap token only for credential setup', async () => {
    const requests: RequestInit[] = [];
    const saveSessionToken = vi.fn(async () => undefined);

    await bootstrapCloudflareCredential(
      { email: 'agency-admin@example.local', password: 'strong-password' },
      {
        apiUrl: 'https://example.workers.dev',
        getBootstrapToken: async () => 'bootstrap-token',
        saveSessionToken,
        fetch: async (_input, init) => {
          requests.push(init ?? {});
          return requests.length === 1
            ? Response.json({ ok: true }, { status: 201 })
            : Response.json({ token: 'signed-session' });
        },
      },
    );

    expect(requests[0]?.headers).toMatchObject({
      authorization: 'Bearer bootstrap-token',
    });
    expect(requests[1]?.headers).not.toMatchObject({
      authorization: expect.any(String),
    });
  });

  it('rotates the stored session after a password change', async () => {
    const saveSessionToken = vi.fn(async () => undefined);

    await expect(
      changeCloudflarePassword('next-strong-password', {
        apiUrl: 'https://example.workers.dev',
        getSessionToken: async () => 'current-session',
        saveSessionToken,
        fetch: async () => Response.json({ token: 'next-session' }),
      }),
    ).resolves.toMatchObject({ authenticated: true });
    expect(saveSessionToken).toHaveBeenCalledWith('next-session');
  });

  it('invalidates the remote session before deleting the local session', async () => {
    const deleteSessionToken = vi.fn(async () => undefined);
    const request = vi.fn(async () => Response.json({ ok: true }));

    await logoutCloudflare({
      apiUrl: 'https://example.workers.dev',
      getSessionToken: async () => 'current-session',
      deleteSessionToken,
      fetch: request,
    });

    expect(request).toHaveBeenCalledWith(
      'https://example.workers.dev/v1/auth/logout',
      expect.objectContaining({
        method: 'POST',
        headers: { authorization: 'Bearer current-session' },
      }),
    );
    expect(deleteSessionToken).toHaveBeenCalledOnce();
  });
});
