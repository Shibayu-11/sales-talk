import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import {
  bootstrapCloudflareCredential,
  changeCloudflarePassword,
  getCloudflareConnectionStatus,
  loginCloudflare,
  logoutCloudflare,
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
