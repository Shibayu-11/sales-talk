import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import {
  acceptCloudflareInvitation,
  bootstrapCloudflareCredential,
  changeCloudflarePassword,
  completeCloudflarePasswordReset,
  createCloudflareInvitation,
  getCloudflareConnectionStatus,
  issueCloudflarePasswordReset,
  listCloudflareOrganizations,
  listCloudflareOrganizationUsers,
  loginCloudflare,
  logoutCloudflare,
  setCloudflareMembershipStatus,
  uploadAudioToCloudAndProcess,
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

  it('accepts invitation tokens and stores the returned session', async () => {
    const saveSessionToken = vi.fn(async () => undefined);
    const request = vi.fn(async () => Response.json({ token: 'invite-session' }, { status: 201 }));

    await expect(
      acceptCloudflareInvitation(
        { token: 'a'.repeat(43), password: 'next-strong-password', displayName: 'Invited User' },
        {
          apiUrl: 'https://example.workers.dev',
          fetch: request,
          saveSessionToken,
        },
      ),
    ).resolves.toMatchObject({ authenticated: true });

    expect(request).toHaveBeenCalledWith(
      'https://example.workers.dev/v1/auth/invitations/accept',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(saveSessionToken).toHaveBeenCalledWith('invite-session');
  });

  it('completes password reset tokens and stores the rotated session', async () => {
    const saveSessionToken = vi.fn(async () => undefined);

    await expect(
      completeCloudflarePasswordReset(
        { token: 'b'.repeat(43), password: 'next-strong-password' },
        {
          apiUrl: 'https://example.workers.dev',
          fetch: async () => Response.json({ token: 'reset-session' }, { status: 201 }),
          saveSessionToken,
        },
      ),
    ).resolves.toMatchObject({ authenticated: true });
    expect(saveSessionToken).toHaveBeenCalledWith('reset-session');
  });

  it('lists cloud organization users with an authenticated session', async () => {
    const request = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json([
        {
          id: '00000000-0000-4000-8000-000000000004',
          email: 'agency-admin@example.local',
          displayName: 'Agency Admin',
          membershipId: '00000000-0000-4000-8000-000000000005',
          tenantId: '00000000-0000-4000-8000-000000000001',
          organizationId: '00000000-0000-4000-8000-000000000002',
          organizationName: 'Local Agency',
          organizationType: 'agency',
          role: 'agency_admin',
          status: 'active',
          hasCredential: true,
          mustResetPassword: false,
          createdAt: '2026-07-15T00:00:00.000Z',
          updatedAt: '2026-07-15T00:00:00.000Z',
        },
      ]),
    );

    await expect(
      listCloudflareOrganizationUsers({
        apiUrl: 'https://example.workers.dev',
        getSessionToken: async () => 'signed-session',
        fetch: request,
      }),
    ).resolves.toMatchObject([{ status: 'active', hasCredential: true }]);
    expect(request).toHaveBeenCalledWith(
      'https://example.workers.dev/v1/organization/users',
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
    const firstInit = request.mock.calls[0]?.[1];
    expect((firstInit?.headers as Headers).get('authorization')).toBe('Bearer signed-session');
  });

  it('lists Cloud organization invitation options from the Worker', async () => {
    const request = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json([
        {
          id: '00000000-0000-4000-8000-000000000002',
          tenantId: '00000000-0000-4000-8000-000000000001',
          parentOrganizationId: '00000000-0000-4000-8000-000000000003',
          type: 'agency',
          name: 'Local Agency',
          createdAt: '2026-07-15T00:00:00.000Z',
          updatedAt: '2026-07-15T00:00:00.000Z',
        },
      ]),
    );

    await expect(
      listCloudflareOrganizations({
        apiUrl: 'https://example.workers.dev',
        getSessionToken: async () => 'signed-session',
        fetch: request,
      }),
    ).resolves.toMatchObject([{ type: 'agency', name: 'Local Agency' }]);
    expect(request).toHaveBeenCalledWith(
      'https://example.workers.dev/v1/organizations',
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
  });

  it('creates invitations and returns the one-time token exactly once', async () => {
    const requests: RequestInit[] = [];
    const request = vi.fn(async (_input, init) => {
      requests.push(init ?? {});
      return Response.json(
        {
          mode: 'manual_beta',
          type: 'invite',
          token: 'c'.repeat(43),
          expiresAt: '2026-07-18T00:00:00.000Z',
          membershipId: '00000000-0000-4000-8000-000000000005',
          userId: '00000000-0000-4000-8000-000000000004',
          organizationId: '00000000-0000-4000-8000-000000000002',
          deliveryId: '00000000-0000-4000-8000-000000000006',
        },
        { status: 201 },
      );
    });

    await expect(
      createCloudflareInvitation(
        {
          email: 'agent@example.local',
          displayName: 'Agent',
          role: 'agent',
          organizationId: '00000000-0000-4000-8000-000000000002',
        },
        {
          apiUrl: 'https://example.workers.dev',
          getSessionToken: async () => 'signed-session',
          fetch: request,
        },
      ),
    ).resolves.toMatchObject({ mode: 'manual_beta', type: 'invite', token: 'c'.repeat(43) });
    expect(JSON.parse(String(requests[0]?.body))).toMatchObject({
      email: 'agent@example.local',
      role: 'agent',
    });
  });

  it('normalizes a legacy Worker token response as manual_beta', async () => {
    await expect(
      createCloudflareInvitation(
        { email: 'agent@example.local', role: 'agent' },
        {
          apiUrl: 'https://example.workers.dev',
          getSessionToken: async () => 'signed-session',
          fetch: async () =>
            Response.json(
              {
                type: 'invite',
                token: 'l'.repeat(43),
                expiresAt: '2026-07-18T00:00:00.000Z',
                membershipId: '00000000-0000-4000-8000-000000000005',
                userId: '00000000-0000-4000-8000-000000000004',
                organizationId: '00000000-0000-4000-8000-000000000002',
              },
              { status: 201 },
            ),
        },
      ),
    ).resolves.toEqual({
      mode: 'manual_beta',
      type: 'invite',
      token: 'l'.repeat(43),
      expiresAt: '2026-07-18T00:00:00.000Z',
      membershipId: '00000000-0000-4000-8000-000000000005',
      userId: '00000000-0000-4000-8000-000000000004',
      organizationId: '00000000-0000-4000-8000-000000000002',
    });
  });

  it('issues password reset tokens and updates membership status via admin routes', async () => {
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v1/organization/password-resets')) {
        return Response.json(
          {
            mode: 'email',
            type: 'password_reset',
            status: 'accepted',
            expiresAt: '2026-07-15T00:30:00.000Z',
            membershipId: '00000000-0000-4000-8000-000000000005',
            userId: '00000000-0000-4000-8000-000000000004',
            organizationId: '00000000-0000-4000-8000-000000000002',
            deliveryId: '00000000-0000-4000-8000-000000000006',
            recipient: { emailMasked: 'a***@e***.local' },
            trackingDegraded: false,
          },
          { status: 201 },
        );
      }
      return Response.json({
        id: '00000000-0000-4000-8000-000000000004',
        email: 'agency-admin@example.local',
        displayName: 'Agency Admin',
        membershipId: '00000000-0000-4000-8000-000000000005',
        tenantId: '00000000-0000-4000-8000-000000000001',
        organizationId: '00000000-0000-4000-8000-000000000002',
        organizationName: 'Local Agency',
        organizationType: 'agency',
        role: 'agency_admin',
        status: 'disabled',
        hasCredential: true,
        mustResetPassword: true,
        createdAt: '2026-07-15T00:00:00.000Z',
        updatedAt: '2026-07-15T00:00:00.000Z',
      });
    });

    await expect(
      issueCloudflarePasswordReset('00000000-0000-4000-8000-000000000005', {
        apiUrl: 'https://example.workers.dev',
        getSessionToken: async () => 'signed-session',
        fetch: request,
      }),
    ).resolves.toMatchObject({ mode: 'email', type: 'password_reset', status: 'accepted' });
    await expect(
      setCloudflareMembershipStatus('00000000-0000-4000-8000-000000000005', 'disabled', {
        apiUrl: 'https://example.workers.dev',
        getSessionToken: async () => 'signed-session',
        fetch: request,
      }),
    ).resolves.toMatchObject({ status: 'disabled', mustResetPassword: true });
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

  it('deletes the local session even when remote logout throws', async () => {
    const deleteSessionToken = vi.fn(async () => undefined);

    await expect(
      logoutCloudflare({
        apiUrl: 'https://example.workers.dev',
        getSessionToken: async () => 'current-session',
        deleteSessionToken,
        fetch: async () => {
          throw new Error('network_down');
        },
      }),
    ).rejects.toThrow('network_down');

    expect(deleteSessionToken).toHaveBeenCalledOnce();
  });

  it('uploads audio with a signed URL and polls the queued STT job', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'sales-talk-cloud-upload-'));
    const audioPath = join(tempDir, 'meeting.mp3');
    await writeFile(audioPath, Buffer.from('audio-bytes'));
    const requests: { input: string | URL | Request; init: RequestInit | undefined }[] = [];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ input, init });
      const url = String(input);
      if (url.endsWith('/v1/audio-upload-urls')) {
        return Response.json(
          {
            uploadId: 'upload-id',
            callId: 'call-id',
            audioAssetId: 'audio-asset-id',
            sttJobId: 'stt-job-id',
            uploadUrl: 'https://upload.example/audio-token',
            expiresAt: new Date().toISOString(),
            method: 'PUT',
            headers: {
              'content-type': 'audio/mpeg',
              'content-length': '11',
            },
          },
          { status: 201 },
        );
      }
      if (url === 'https://upload.example/audio-token') {
        return Response.json(
          { callId: 'call-id', audioAssetId: 'audio-asset-id', sttJobId: 'stt-job-id' },
          { status: 201 },
        );
      }
      if (url.endsWith('/v1/stt-jobs/stt-job-id')) {
        return Response.json({
          id: 'stt-job-id',
          call_id: 'call-id',
          audio_asset_id: 'audio-asset-id',
          provider: 'deepgram',
          status: 'completed',
          error_message: null,
          created_at: '2026-06-08T00:00:00.000Z',
          updated_at: '2026-06-08T00:00:01.000Z',
        });
      }
      if (url.endsWith('/v1/calls/call-id/transcripts')) {
        return Response.json([{ id: 'segment-1' }, { id: 'segment-2' }]);
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    });

    try {
      await expect(
        uploadAudioToCloudAndProcess(
          { filePath: audioPath, productId: 'kenko_keiei' },
          {
            apiUrl: 'https://example.workers.dev',
            fetch: request,
            getSessionToken: async () => 'signed-session',
            pollIntervalMs: 0,
          },
        ),
      ).resolves.toMatchObject({
        callId: 'call-id',
        audioAssetId: 'audio-asset-id',
        sttJobId: 'stt-job-id',
        status: 'completed',
        transcriptCount: 2,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }

    expect(requests[0]?.init?.headers).toMatchObject({
      authorization: 'Bearer signed-session',
      'content-type': 'application/json',
    });
    expect(requests[1]).toMatchObject({
      input: 'https://upload.example/audio-token',
      init: expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({
          'content-type': 'audio/mpeg',
          'content-length': '11',
        }),
      }),
    });
    expect(String(requests[2]?.input)).toBe('https://example.workers.dev/v1/stt-jobs/stt-job-id');
  });
});
