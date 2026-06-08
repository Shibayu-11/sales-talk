import { describe, expect, it } from 'vitest';
import {
  createPasswordCredential,
  createSignedPayloadToken,
  createSessionToken,
  verifySignedPayloadToken,
  verifyPassword,
  verifySessionToken,
} from '../../cloudflare/src/auth';

describe('Cloudflare auth', () => {
  it('hashes and verifies passwords without storing plaintext', async () => {
    const credential = await createPasswordCredential('strong-password');

    expect(credential.passwordHash).not.toContain('strong-password');
    await expect(verifyPassword('strong-password', credential)).resolves.toBe(true);
    await expect(verifyPassword('wrong-password', credential)).resolves.toBe(false);
  });

  it('signs, verifies, and expires user sessions', async () => {
    const now = new Date('2026-06-08T00:00:00.000Z');
    const session = await createSessionToken(
      {
        userId: 'user-id',
        tenantId: 'tenant-id',
        organizationId: 'organization-id',
        membershipId: 'membership-id',
        sessionVersion: 1,
      },
      'session-signing-key',
      now,
    );

    await expect(verifySessionToken(session.token, 'session-signing-key', now)).resolves.toMatchObject({
      userId: 'user-id',
      tenantId: 'tenant-id',
    });
    await expect(
      verifySessionToken(session.token, 'wrong-signing-key', now),
    ).resolves.toBeNull();
    await expect(
      verifySessionToken(session.token, 'session-signing-key', new Date('2026-06-09T00:00:00.000Z')),
    ).resolves.toBeNull();
  });

  it('signs generic one-time upload payloads', async () => {
    const now = new Date('2026-06-08T00:00:00.000Z');
    const signed = await createSignedPayloadToken(
      { uploadId: 'upload-id', sizeBytes: 123 },
      'session-signing-key',
      900,
      now,
    );

    await expect(
      verifySignedPayloadToken(
        signed.token,
        'session-signing-key',
        (payload) =>
          typeof payload.uploadId === 'string' && typeof payload.sizeBytes === 'number'
            ? { uploadId: payload.uploadId, sizeBytes: payload.sizeBytes }
            : null,
        now,
      ),
    ).resolves.toEqual({ uploadId: 'upload-id', sizeBytes: 123 });
    await expect(
      verifySignedPayloadToken(
        signed.token,
        'session-signing-key',
        () => ({ ok: true }),
        new Date('2026-06-08T00:16:00.000Z'),
      ),
    ).resolves.toBeNull();
  });
});
