import { describe, expect, it, vi } from 'vitest';
import { RecorderApi, RecorderApiError } from '../../src/mobile/lib/recorder-api';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function blob(bytes = 1000, type = 'audio/mp4'): Blob {
  return new Blob([new Uint8Array(bytes)], { type });
}

describe('RecorderApi.login', () => {
  it('stores the session token on success', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ sessionToken: 'sess-1' }));
    const api = new RecorderApi({ apiUrl: 'https://api.test/', fetchImpl });

    await api.login('agent@example.com', 'pw-123456789012');

    expect(api.isAuthenticated).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.test/v1/auth/login',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws a coded error on failure', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'invalid_credentials' }, 401));
    const api = new RecorderApi({ apiUrl: 'https://api.test', fetchImpl });

    await expect(api.login('a@b.c', 'x')).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect(api.isAuthenticated).toBe(false);
  });
});

describe('RecorderApi.uploadRecording', () => {
  it('requests a signed url, PUTs the blob, polls to completion, and counts transcripts', async () => {
    const calls: string[] = [];
    let pollCount = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method ?? 'GET'} ${u}`);
      if (u.endsWith('/v1/audio-upload-urls')) {
        return jsonResponse(
          {
            uploadUrl: 'https://api.test/v1/audio-upload-urls/token123',
            callId: 'call-1',
            sttJobId: 'job-1',
            method: 'PUT',
            headers: { 'content-type': 'audio/mp4' },
          },
          201,
        );
      }
      if (u.includes('/audio-upload-urls/token123')) {
        return new Response(null, { status: 200 });
      }
      if (u.includes('/v1/stt-jobs/job-1')) {
        pollCount += 1;
        return jsonResponse({ id: 'job-1', status: pollCount < 2 ? 'running' : 'completed' });
      }
      if (u.includes('/v1/calls/call-1/transcripts')) {
        return jsonResponse([{ id: 's1' }, { id: 's2' }, { id: 's3' }]);
      }
      throw new Error(`unexpected url ${u}`);
    });

    const api = new RecorderApi({ apiUrl: 'https://api.test', fetchImpl });
    api.setSessionToken('sess-1');

    const result = await api.uploadRecording({
      blob: blob(2048),
      fileName: 'visit.mp4',
      productId: 'real_estate',
      pollIntervalMs: 1,
      now: () => 0,
      sleep: async () => {},
    });

    expect(result).toEqual({
      callId: 'call-1',
      sttJobId: 'job-1',
      status: 'completed',
      transcriptCount: 3,
    });
    // Signed URL request carried the bearer token.
    const signedReqCall = fetchImpl.mock.calls.find(([u]) =>
      String(u).endsWith('/v1/audio-upload-urls'),
    );
    expect((signedReqCall?.[1]?.headers as Record<string, string>).authorization).toBe('Bearer sess-1');
    // PUT happened after the signed URL.
    expect(calls).toContain('PUT https://api.test/v1/audio-upload-urls/token123');
  });

  it('rejects when not authenticated', async () => {
    const api = new RecorderApi({ apiUrl: 'https://api.test', fetchImpl: vi.fn() });
    await expect(
      api.uploadRecording({ blob: blob(), fileName: 'x.mp4', productId: 'real_estate' }),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('surfaces a failed STT job', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/v1/audio-upload-urls')) {
        return jsonResponse(
          { uploadUrl: 'https://api.test/up/t', callId: 'c', sttJobId: 'j', method: 'PUT', headers: {} },
          201,
        );
      }
      if (u.includes('/up/t')) return new Response(null, { status: 200 });
      if (u.includes('/v1/stt-jobs/')) {
        return jsonResponse({ id: 'j', status: 'failed', errorMessage: 'deepgram error' });
      }
      throw new Error('unexpected');
    });
    const api = new RecorderApi({ apiUrl: 'https://api.test', fetchImpl });
    api.setSessionToken('s');

    await expect(
      api.uploadRecording({
        blob: blob(),
        fileName: 'x.mp4',
        productId: 'real_estate',
        sleep: async () => {},
        now: () => 0,
      }),
    ).rejects.toBeInstanceOf(RecorderApiError);
  });

  it('times out if the job never completes', async () => {
    let t = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/v1/audio-upload-urls')) {
        return jsonResponse(
          { uploadUrl: 'https://api.test/up/t', callId: 'c', sttJobId: 'j', method: 'PUT', headers: {} },
          201,
        );
      }
      if (u.includes('/up/t')) return new Response(null, { status: 200 });
      if (u.includes('/v1/stt-jobs/')) return jsonResponse({ id: 'j', status: 'running' });
      throw new Error('unexpected');
    });
    const api = new RecorderApi({ apiUrl: 'https://api.test', fetchImpl });
    api.setSessionToken('s');

    await expect(
      api.uploadRecording({
        blob: blob(),
        fileName: 'x.mp4',
        productId: 'real_estate',
        timeoutMs: 10,
        pollIntervalMs: 5,
        now: () => (t += 6),
        sleep: async () => {},
      }),
    ).rejects.toMatchObject({ code: 'stt_timeout' });
  });
});
