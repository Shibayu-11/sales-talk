import { describe, expect, it } from 'vitest';
import {
  AudioCaptureStatusSchema,
  AudioDiagnosticSessionResultSchema,
  AudioChunkSchema,
  AudioSttJobCancelInputSchema,
  AudioSttJobRetryInputSchema,
  AudioSttJobSchema,
  AuditActionSchema,
  CallStartInputSchema,
  CloudActionTokenResultSchema,
  CloudflareCredentialInputSchema,
  CloudflareTokenPasswordInputSchema,
  CloudOrganizationInvitationInputSchema,
  CloudOrganizationSchema,
  CloudOrganizationMembershipStatusInputSchema,
  CloudOrganizationUserSchema,
  KnowledgeSearchInputSchema,
  MeetingMinuteSchema,
  MinutesGetInputSchema,
  ObjectionResponseSchema,
  OverlayLayerSchema,
  RecoveryRetentionInputSchema,
  RecoverySummarySchema,
  ReviewTaskSchema,
  SecretSetInputSchema,
  SonnetResponseOutputSchema,
  StartRecordingSessionResultSchema,
  TranscriptRevisionActivateInputSchema,
  TranscriptRevisionSchema,
  TranscriptSegmentSchema,
} from '../../src/shared/schemas';

const baseSonnetOutput = {
  layer1Peek: '比較で整理',
  layer2Summary: { mainResponse: '比較しましょう', keyPoints: ['総額で比較'] },
  layer3Detail: { fullScript: '一般論として比較しましょう', rationale: '有効', cautions: [], similarCases: [] },
  confidence: 0.8,
  riskFlags: [],
};

describe('shared schemas', () => {
  it('rejects invalid overlay layers', () => {
    expect(() => OverlayLayerSchema.parse(4)).toThrow();
  });

  it('rejects empty secret values', () => {
    expect(() => SecretSetInputSchema.parse({ key: 'deepgram_api_key', value: '' })).toThrow();
  });

  it('requires a strong enough Cloudflare login password', () => {
    expect(() =>
      CloudflareCredentialInputSchema.parse({
        email: 'agency-admin@example.local',
        password: 'short',
      }),
    ).toThrow();
  });

  it('validates Cloudflare account lifecycle IPC contracts', () => {
    expect(
      CloudflareTokenPasswordInputSchema.parse({
        token: 'a'.repeat(43),
        password: 'long-enough-password',
        displayName: 'New User',
      }),
    ).toMatchObject({ token: 'a'.repeat(43), displayName: 'New User' });
    expect(() =>
      CloudOrganizationInvitationInputSchema.parse({
        email: 'user@example.local',
        role: 'insurer_admin',
        organizationId: 'not-a-uuid',
      }),
    ).toThrow();
    expect(
      CloudOrganizationMembershipStatusInputSchema.parse({
        membershipId: '00000000-0000-4000-8000-000000000005',
        status: 'disabled',
      }),
    ).toEqual({
      membershipId: '00000000-0000-4000-8000-000000000005',
      status: 'disabled',
    });
    const manualAction = CloudActionTokenResultSchema.parse({
        mode: 'manual_beta',
        type: 'invite',
        token: 'b'.repeat(43),
        expiresAt: '2026-07-18T00:00:00.000Z',
        membershipId: '00000000-0000-4000-8000-000000000005',
        userId: '00000000-0000-4000-8000-000000000004',
        organizationId: '00000000-0000-4000-8000-000000000002',
        deliveryId: '00000000-0000-4000-8000-000000000006',
      });
    expect(manualAction.mode).toBe('manual_beta');
    if (manualAction.mode === 'manual_beta') {
      expect(manualAction.token).toHaveLength(43);
    }
    expect(
      CloudActionTokenResultSchema.parse({
        type: 'password_reset',
        token: 'c'.repeat(43),
        expiresAt: '2026-07-18T00:00:00.000Z',
        membershipId: '00000000-0000-4000-8000-000000000005',
        userId: '00000000-0000-4000-8000-000000000004',
        organizationId: '00000000-0000-4000-8000-000000000002',
      }),
    ).toMatchObject({ mode: 'manual_beta', token: 'c'.repeat(43) });
    expect(
      CloudActionTokenResultSchema.parse({
        mode: 'email',
        type: 'password_reset',
        status: 'accepted',
        expiresAt: '2026-07-18T00:00:00.000Z',
        membershipId: '00000000-0000-4000-8000-000000000005',
        userId: '00000000-0000-4000-8000-000000000004',
        organizationId: '00000000-0000-4000-8000-000000000002',
        deliveryId: '00000000-0000-4000-8000-000000000006',
        recipient: { emailMasked: 'u***@e***.com' },
        trackingDegraded: false,
      }),
    ).not.toHaveProperty('token');
    expect(
      CloudOrganizationUserSchema.parse({
        id: '00000000-0000-4000-8000-000000000004',
        email: 'agency-admin@example.local',
        displayName: 'Agency Admin',
        membershipId: '00000000-0000-4000-8000-000000000005',
        tenantId: '00000000-0000-4000-8000-000000000001',
        organizationId: '00000000-0000-4000-8000-000000000002',
        organizationName: 'Agency',
        organizationType: 'agency',
        role: 'agency_admin',
        status: 'active',
        hasCredential: true,
        mustResetPassword: false,
        createdAt: '2026-07-15T00:00:00.000Z',
        updatedAt: '2026-07-15T00:00:00.000Z',
      }).status,
    ).toBe('active');
    expect(
      CloudOrganizationSchema.parse({
        id: '00000000-0000-4000-8000-000000000002',
        tenantId: '00000000-0000-4000-8000-000000000001',
        parentOrganizationId: '00000000-0000-4000-8000-000000000003',
        type: 'agency',
        name: 'Agency',
        createdAt: '2026-07-15T00:00:00.000Z',
        updatedAt: '2026-07-15T00:00:00.000Z',
      }).type,
    ).toBe('agency');
  });

  it('normalizes knowledge search query limits', () => {
    const input = KnowledgeSearchInputSchema.parse({
      query: '  価格が高い  ',
      productId: 'real_estate',
      limit: 5,
    });

    expect(input.query).toBe('価格が高い');
    expect(input.limit).toBe(5);
  });

  it('validates audio chunks before they cross IPC boundaries', () => {
    expect(
      AudioChunkSchema.parse({
        speaker: 'counterpart',
        data: 'base64-audio',
        startMs: 0,
        durationMs: 100,
      }),
    ).toEqual({
      speaker: 'counterpart',
      data: 'base64-audio',
      startMs: 0,
      durationMs: 100,
    });

    expect(() =>
      AudioChunkSchema.parse({
        speaker: 'counterpart',
        data: '',
        startMs: -1,
        durationMs: 0,
      }),
    ).toThrow();
  });

  it('validates the audio status IPC output contract', () => {
    const status = AudioCaptureStatusSchema.parse({
      nativeModule: {
        available: true,
        contractValid: true,
        modulePath: '/tmp/audio_capture.node',
      },
      permissions: { screen: true, microphone: true },
      stats: {
        self: { chunks: 1, bytes: 3200, lastReceivedAtMs: 1_000 },
        counterpart: { chunks: 1, bytes: 3200, lastReceivedAtMs: 1_000 },
        total: { chunks: 2, bytes: 6400, lastReceivedAtMs: 1_000 },
      },
      sttState: 'connected',
      nativeCaptureActive: true,
      preflight: {
        overall: 'go',
        startedAtMs: 1,
        evaluatedAtMs: 2,
        checks: [
          {
            id: 'native_capture',
            label: 'Native capture',
            status: 'pass',
            message: 'native capture は active です。',
            action: null,
          },
        ],
      },
    });

    expect(status.preflight.overall).toBe('go');
    expect(() =>
      AudioCaptureStatusSchema.parse({
        ...status,
        preflight: {
          ...status.preflight,
          checks: [{ ...status.preflight.checks[0]!, status: 'unknown' }],
        },
      }),
    ).toThrow();
  });

  it('validates recording and diagnostic result IPC output contracts', () => {
    expect(
      StartRecordingSessionResultSchema.parse({
        ok: true,
        callId: '00000000-0000-4000-8000-000000000001',
      }),
    ).toEqual({
      ok: true,
      callId: '00000000-0000-4000-8000-000000000001',
    });
    expect(
      StartRecordingSessionResultSchema.parse({
        ok: false,
        error: 'already_recording',
        callId: '00000000-0000-4000-8000-000000000001',
      }),
    ).toEqual({
      ok: false,
      error: 'already_recording',
      callId: '00000000-0000-4000-8000-000000000001',
    });
    expect(AudioDiagnosticSessionResultSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(
      AudioDiagnosticSessionResultSchema.parse({
        ok: false,
        error: 'recording_in_progress',
      }),
    ).toEqual({
      ok: false,
      error: 'recording_in_progress',
    });

    expect(() =>
      StartRecordingSessionResultSchema.parse({ ok: false, error: 'not_running' }),
    ).toThrow();
    expect(() =>
      AudioDiagnosticSessionResultSchema.parse({ ok: false, error: 'already_recording' }),
    ).toThrow();
  });

  it('validates recovery IPC contracts without exposing key or path fields', () => {
    const summary = RecoverySummarySchema.parse({
      callId: '00000000-0000-4000-8000-000000000001',
      tenantId: '00000000-0000-4000-8000-000000000002',
      organizationId: '00000000-0000-4000-8000-000000000003',
      ownerUserId: '00000000-0000-4000-8000-000000000004',
      ownerMembershipId: '00000000-0000-4000-8000-000000000005',
      productId: 'real_estate',
      source: 'zoom_desktop',
      state: 'recoverable',
      startedAt: '2026-07-18T00:00:00.000Z',
      lastCheckpointAt: '2026-07-18T00:00:05.000Z',
      expiresAt: '2026-07-25T00:00:00.000Z',
      retentionDays: 7,
      expired: false,
      chunkCount: 2,
      durationMs: 5_000,
      availableSpeakers: ['self', 'counterpart'],
    });

    expect(summary).not.toHaveProperty('wrappedSessionKey');
    expect(summary).not.toHaveProperty('segments');
    expect(summary).not.toHaveProperty('filePath');
    expect(summary.ownerUserId).toBe('00000000-0000-4000-8000-000000000004');
    expect(summary.ownerMembershipId).toBe('00000000-0000-4000-8000-000000000005');
    expect(
      RecoveryRetentionInputSchema.parse({
        callId: summary.callId,
        retentionDays: 30,
      }).retentionDays,
    ).toBe(30);
    expect(AuditActionSchema.parse('checkpoint.recovered')).toBe('checkpoint.recovered');
    expect(() =>
      RecoveryRetentionInputSchema.parse({
        callId: summary.callId,
        retentionDays: 14,
      }),
    ).toThrow();
  });

  it('accepts Sonnet output with and without knowledgeSourceIds', () => {
    const withoutIds = SonnetResponseOutputSchema.parse(baseSonnetOutput);
    expect(withoutIds.knowledgeSourceIds).toEqual([]);

    const withIds = SonnetResponseOutputSchema.parse({
      ...baseSonnetOutput,
      knowledgeSourceIds: ['k-1', 'k-2'],
    });
    expect(withIds.knowledgeSourceIds).toEqual(['k-1', 'k-2']);
  });

  it('validates ObjectionResponse sources citations', () => {
    const parsed = ObjectionResponseSchema.parse({
      id: '00000000-0000-4000-8000-000000000001',
      objectionId: '00000000-0000-4000-8000-000000000002',
      peak: '比較で整理',
      summary: ['総額で比較'],
      fullScript: '一般論として比較しましょう',
      reasoning: '有効',
      notes: [],
      riskFlags: [],
      sources: [{ knowledgeId: 'k-1', trigger: '価格が高い', score: 0.5 }],
      generatedAtMs: 1,
    });
    expect(parsed.sources[0]?.knowledgeId).toBe('k-1');

    expect(() =>
      ObjectionResponseSchema.parse({
        id: '00000000-0000-4000-8000-000000000001',
        objectionId: '00000000-0000-4000-8000-000000000002',
        peak: 'x',
        summary: [],
        fullScript: '',
        reasoning: '',
        notes: [],
        riskFlags: [],
        generatedAtMs: 1,
      }),
    ).toThrow();
  });

  it('rejects realtime recording start without granted consent', () => {
    expect(() =>
      CallStartInputSchema.parse({
        productId: 'real_estate',
        consent: {
          status: 'pending',
          method: null,
          capturedAt: null,
          noticeVersion: 'local-v1',
        },
      }),
    ).toThrow();
  });

  it('validates re-transcription schemas and backward-compatible defaults', () => {
    const legacySegment = TranscriptSegmentSchema.parse({
      id: '00000000-0000-4000-8000-000000000001',
      callId: '00000000-0000-4000-8000-000000000002',
      speaker: 'counterpart',
      text: '旧形式',
      isFinal: true,
      startMs: 0,
      endMs: 100,
      createdAt: '2026-07-18T00:00:00.000Z',
    });
    expect(legacySegment.revisionId).toBeNull();
    expect(legacySegment.sourceJobId).toBeNull();

    const legacyJob = AudioSttJobSchema.parse({
      id: '00000000-0000-4000-8000-000000000003',
      callId: '00000000-0000-4000-8000-000000000002',
      audioAssetId: '00000000-0000-4000-8000-000000000004',
      provider: 'deepgram',
      status: 'queued',
      errorMessage: null,
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
    });
    expect(legacyJob.runToken).toBeNull();
    expect(legacyJob.progressPercent).toBe(0);
    expect(legacyJob.attempt).toBe(1);
    expect(legacyJob.retryReason).toBeNull();
    expect(legacyJob.transcriptRevisionId).toBeNull();

    expect(
      TranscriptRevisionSchema.parse({
        id: '00000000-0000-4000-8000-000000000005',
        callId: '00000000-0000-4000-8000-000000000002',
        origin: 'live',
        revisionNumber: 1,
        reason: 'original_live_transcript',
        segmentCount: 1,
        createdAt: '2026-07-18T00:00:00.000Z',
      }),
    ).toMatchObject({
      audioAssetId: null,
      sttJobId: null,
      provider: null,
      active: false,
    });

    expect(
      AudioSttJobRetryInputSchema.parse({
        jobId: '00000000-0000-4000-8000-000000000003',
        reason: 'operator_retry',
        provider: 'apple_speech_analyzer',
      }),
    ).toMatchObject({ reason: 'operator_retry', provider: 'apple_speech_analyzer' });
    expect(
      AudioSttJobCancelInputSchema.parse({
        jobId: '00000000-0000-4000-8000-000000000003',
      }).jobId,
    ).toBe('00000000-0000-4000-8000-000000000003');
    expect(
      TranscriptRevisionActivateInputSchema.parse({
        callId: '00000000-0000-4000-8000-000000000002',
        revisionId: '00000000-0000-4000-8000-000000000005',
      }).revisionId,
    ).toBe('00000000-0000-4000-8000-000000000005');
    expect(AuditActionSchema.parse('stt_job.retried')).toBe('stt_job.retried');
    expect(AuditActionSchema.parse('stt_job.cancelled')).toBe('stt_job.cancelled');
    expect(AuditActionSchema.parse('transcript.revision_created')).toBe(
      'transcript.revision_created',
    );
    expect(AuditActionSchema.parse('transcript.revision_activated')).toBe(
      'transcript.revision_activated',
    );
  });

  it('defaults meeting analysis revision fields for legacy payloads', () => {
    const legacyMinute = MeetingMinuteSchema.parse({
      id: '00000000-0000-4000-8000-000000000601',
      callId: '00000000-0000-4000-8000-000000000602',
      source: 'manual_transcript',
      productId: 'real_estate',
      summary: '旧議事録',
      agreed: [],
      pending: [],
      decisions: [],
      numbers: [],
      complianceFindings: [],
      generatedAt: '2026-07-18T00:00:00.000Z',
    });
    expect(legacyMinute.transcriptRevisionId).toBeNull();

    const legacyTask = ReviewTaskSchema.parse({
      id: '00000000-0000-4000-8000-000000000603',
      callId: '00000000-0000-4000-8000-000000000602',
      meetingMinuteId: '00000000-0000-4000-8000-000000000601',
      findingId: '00000000-0000-4000-8000-000000000604',
      severity: 'high',
      status: 'open',
      title: '高リスク発話の確認',
      quotedText: '断定表現',
      reason: '将来利益を断定しています。',
      recommendedAction: '条件とリスクを説明します。',
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
    });
    expect(legacyTask.transcriptRevisionId).toBeNull();

    expect(MinutesGetInputSchema.parse(undefined)).toEqual({});
    expect(
      MinutesGetInputSchema.parse({
        callId: '00000000-0000-4000-8000-000000000602',
        transcriptRevisionId: null,
      }),
    ).toEqual({
      callId: '00000000-0000-4000-8000-000000000602',
      transcriptRevisionId: null,
    });
    expect(() =>
      MinutesGetInputSchema.parse({
        transcriptRevisionId: 'not-a-uuid',
      }),
    ).toThrow();
  });
});
