import type { ProductId } from '@shared/types';

/**
 * Mobile recorder → Cloudflare Worker client. Mirrors the contract already
 * implemented in cloudflare/src/index.ts (auth + signed audio upload + STT poll).
 * fetch is injected so the flow is unit-testable without a deployed Worker.
 */

export interface RecorderApiOptions {
  apiUrl: string;
  fetchImpl?: typeof fetch;
}

export interface UploadResult {
  callId: string;
  sttJobId: string;
  transcriptCount: number;
  status: SttJobStatus;
}

export type SttJobStatus = 'queued' | 'running' | 'completed' | 'failed';

interface SignedUploadResponse {
  uploadUrl: string;
  callId: string;
  sttJobId: string;
  method: string;
  headers: Record<string, string>;
}

interface SttJobResponse {
  id: string;
  status: SttJobStatus;
  errorMessage?: string | null;
}

export class RecorderApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'RecorderApiError';
  }
}

export class RecorderApi {
  private readonly apiUrl: string;
  private readonly fetchImpl: typeof fetch;
  private sessionToken: string | null = null;

  constructor(options: RecorderApiOptions) {
    this.apiUrl = options.apiUrl.replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  get isAuthenticated(): boolean {
    return this.sessionToken !== null;
  }

  setSessionToken(token: string | null): void {
    this.sessionToken = token;
  }

  async login(email: string, password: string): Promise<void> {
    const res = await this.fetchImpl(`${this.apiUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      throw await this.toError(res, 'login_failed');
    }
    const body = (await res.json()) as { sessionToken?: string };
    if (!body.sessionToken) {
      throw new RecorderApiError('login response missing session token', 'login_failed');
    }
    this.sessionToken = body.sessionToken;
  }

  /**
   * Upload a recorded blob: request a signed URL, PUT the bytes, then poll the
   * STT job to completion. Returns the transcript count when done.
   */
  async uploadRecording(input: {
    blob: Blob;
    fileName: string;
    productId: ProductId;
    pollIntervalMs?: number;
    timeoutMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  }): Promise<UploadResult> {
    if (!this.sessionToken) {
      throw new RecorderApiError('not authenticated', 'unauthenticated');
    }

    const signed = await this.requestSignedUrl({
      fileName: input.fileName,
      mimeType: input.blob.type || 'application/octet-stream',
      sizeBytes: input.blob.size,
      productId: input.productId,
    });

    const putRes = await this.fetchImpl(signed.uploadUrl, {
      method: signed.method,
      headers: signed.headers,
      body: input.blob,
    });
    if (!putRes.ok) {
      throw await this.toError(putRes, 'upload_failed');
    }

    const finalStatus = await this.pollSttJob(signed.sttJobId, {
      pollIntervalMs: input.pollIntervalMs ?? 1_500,
      timeoutMs: input.timeoutMs ?? 120_000,
      now: input.now ?? (() => Date.now()),
      sleep: input.sleep ?? defaultSleep,
    });

    const transcriptCount = await this.fetchTranscriptCount(signed.callId);
    return {
      callId: signed.callId,
      sttJobId: signed.sttJobId,
      status: finalStatus,
      transcriptCount,
    };
  }

  private async requestSignedUrl(input: {
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    productId: ProductId;
  }): Promise<SignedUploadResponse> {
    const res = await this.fetchImpl(`${this.apiUrl}/v1/audio-upload-urls`, {
      method: 'POST',
      headers: this.authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      throw await this.toError(res, 'signed_url_failed');
    }
    return (await res.json()) as SignedUploadResponse;
  }

  private async pollSttJob(
    jobId: string,
    opts: { pollIntervalMs: number; timeoutMs: number; now: () => number; sleep: (ms: number) => Promise<void> },
  ): Promise<SttJobStatus> {
    const deadline = opts.now() + opts.timeoutMs;
    for (;;) {
      const res = await this.fetchImpl(`${this.apiUrl}/v1/stt-jobs/${encodeURIComponent(jobId)}`, {
        headers: this.authHeaders(),
      });
      if (!res.ok) {
        throw await this.toError(res, 'stt_poll_failed');
      }
      const job = (await res.json()) as SttJobResponse;
      if (job.status === 'completed') {
        return 'completed';
      }
      if (job.status === 'failed') {
        throw new RecorderApiError(job.errorMessage ?? 'stt job failed', 'stt_failed');
      }
      if (opts.now() >= deadline) {
        throw new RecorderApiError('stt job timed out', 'stt_timeout');
      }
      await opts.sleep(opts.pollIntervalMs);
    }
  }

  private async fetchTranscriptCount(callId: string): Promise<number> {
    const res = await this.fetchImpl(
      `${this.apiUrl}/v1/calls/${encodeURIComponent(callId)}/transcripts`,
      { headers: this.authHeaders() },
    );
    if (!res.ok) {
      throw await this.toError(res, 'transcripts_failed');
    }
    const segments = (await res.json()) as unknown[];
    return Array.isArray(segments) ? segments.length : 0;
  }

  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { ...extra, authorization: `Bearer ${this.sessionToken ?? ''}` };
  }

  private async toError(res: Response, fallbackCode: string): Promise<RecorderApiError> {
    let code = fallbackCode;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) code = body.error;
    } catch {
      // non-JSON error body; keep fallback
    }
    return new RecorderApiError(`${fallbackCode} (${res.status})`, code);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
