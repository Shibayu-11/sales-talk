import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const guardScript = join(process.cwd(), 'scripts/assert-cloudflare-production-email.mjs');

describe('Cloudflare production email config guard', () => {
  it('accepts the root production config only in email mode', async () => {
    await expect(execFileAsync(process.execPath, [guardScript])).resolves.toBeDefined();
  });

  it('rejects a production config left in manual_beta mode', async () => {
    await expectConfigRejected(
      { vars: { AUTH_EMAIL_DELIVERY_MODE: 'manual_beta' } },
      'production_auth_email_delivery_mode_must_be_email',
    );
  });

  it('rejects email mode without a sender address', async () => {
    await expectConfigRejected(
      { vars: { AUTH_EMAIL_DELIVERY_MODE: 'email' } },
      'production_auth_email_from_required',
    );
  });

  it('rejects email mode without the AUTH_EMAIL binding', async () => {
    await expectConfigRejected(
      {
        vars: {
          AUTH_EMAIL_DELIVERY_MODE: 'email',
          AUTH_EMAIL_FROM: 'noreply@example.com',
        },
      },
      'production_auth_email_binding_required',
    );
  });

  it('rejects a binding that does not restrict the configured sender', async () => {
    await expectConfigRejected(
      {
        vars: {
          AUTH_EMAIL_DELIVERY_MODE: 'email',
          AUTH_EMAIL_FROM: 'noreply@example.com',
        },
        send_email: [
          {
            name: 'AUTH_EMAIL',
            allowed_sender_addresses: ['other@example.com'],
          },
        ],
      },
      'production_auth_email_sender_restriction_required',
    );
  });
});

async function expectConfigRejected(config: unknown, errorCode: string): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), 'sales-talk-wrangler-'));
  const configPath = join(tempDir, 'wrangler.jsonc');
  try {
    await writeFile(configPath, JSON.stringify(config));
    await expect(execFileAsync(process.execPath, [guardScript, configPath])).rejects.toMatchObject({
      stderr: expect.stringContaining(errorCode),
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
