import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import {
  AuthEmailDeliveryError,
  assertAuthEmailDeliveryConfigured,
  escapeHtml,
  renderAuthActionEmail,
  sendAuthActionEmail,
} from '../../cloudflare/src/auth-email';
import type { ActionTokenIssueResult } from '../../cloudflare/src/account-lifecycle';

describe('Cloudflare auth email delivery', () => {
  it('rejects invalid or incomplete email config before any D1 mutation', () => {
    const database = new FakeDeliveryDatabase();
    const DB = database.asD1Database();

    expect(() =>
      assertAuthEmailDeliveryConfigured({ DB, AUTH_EMAIL_DELIVERY_MODE: 'invalid' }),
    ).toThrowError(new AuthEmailDeliveryError(503, 'auth_email_delivery_mode_invalid'));
    expect(() =>
      assertAuthEmailDeliveryConfigured({ DB, AUTH_EMAIL_DELIVERY_MODE: 'email' }),
    ).toThrowError(new AuthEmailDeliveryError(503, 'auth_email_binding_not_configured'));
    expect(() =>
      assertAuthEmailDeliveryConfigured({
        DB,
        AUTH_EMAIL_DELIVERY_MODE: 'email',
        AUTH_EMAIL: { send: async () => ({}) },
      }),
    ).toThrowError(new AuthEmailDeliveryError(503, 'auth_email_from_not_configured'));
    expect(database.statements).toHaveLength(0);
  });

  it('checks invite and reset email config before lifecycle issuance in routes', () => {
    const source = readFileSync(join(process.cwd(), 'cloudflare/src/index.ts'), 'utf8');
    const invitationRoute = source.slice(
      source.indexOf("url.pathname === '/v1/organization/invitations'"),
      source.indexOf("url.pathname === '/v1/organization/password-resets'"),
    );
    const resetRoute = source.slice(
      source.indexOf("url.pathname === '/v1/organization/password-resets'"),
      source.indexOf('const membershipStatusMatch'),
    );

    expect(invitationRoute.indexOf('assertAuthEmailDeliveryConfigured')).toBeLessThan(
      invitationRoute.indexOf('createInvitation('),
    );
    expect(resetRoute.indexOf('assertAuthEmailDeliveryConfigured')).toBeLessThan(
      resetRoute.indexOf('issuePasswordReset('),
    );
  });

  it('documents delivery tracking without plaintext token, body, or recipient columns', () => {
    const migration = readFileSync(
      join(process.cwd(), 'cloudflare/migrations/0008_auth_email_delivery.sql'),
      'utf8',
    );

    expect(migration).toContain('CREATE TABLE auth_action_deliveries');
    expect(migration).toContain("CHECK (status IN ('pending', 'accepted', 'failed', 'cancelled'))");
    expect(migration).toContain('provider_message_id TEXT');
    expect(migration).toContain('active_password_reset_token_id TEXT REFERENCES auth_action_tokens(id)');
    expect(migration).not.toMatch(/\btoken\b TEXT/i);
    expect(migration).not.toMatch(/body/i);
    expect(migration).not.toMatch(/recipient_email/i);
  });

  it('escapes Japanese HTML template values and avoids token deep links', () => {
    const content = renderAuthActionEmail({
      ...baseIssue('invite'),
      token: '<token>&"\'',
      recipientDisplayName: '<Admin & User>',
    });

    expect(content.html).toContain('&lt;Admin &amp; User&gt;');
    expect(content.html).toContain('&lt;token&gt;&amp;&quot;&#39;');
    expect(content.html).not.toContain('<token>');
    expect(content.html).not.toMatch(/href=/i);
    expect(content.text).toContain('アプリの設定画面');
    expect(escapeHtml('<>&"\'')).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('returns email accepted public object without exposing the raw token', async () => {
    const database = new FakeDeliveryDatabase();
    const send = vi.fn(async () => ({ messageId: 'cf-message-id' }));

    const result = await sendAuthActionEmail(
      {
        DB: database.asD1Database(),
        AUTH_EMAIL: { send },
        AUTH_EMAIL_DELIVERY_MODE: 'email',
        AUTH_EMAIL_FROM: 'noreply@example.com',
        AUTH_EMAIL_FROM_NAME: 'SalesTalk',
      },
      baseIssue('invite'),
      new Date('2026-07-18T00:00:00.000Z'),
    );

    expect(result).toMatchObject({
      mode: 'email',
      status: 'accepted',
      recipient: { emailMasked: 'u***@e***.com' },
      trackingDegraded: false,
    });
    expect(JSON.stringify(result)).not.toContain(baseIssue('invite').token);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@example.com',
        from: { email: 'noreply@example.com', name: 'SalesTalk' },
      }),
    );
  });

  it('keeps manual_beta compatibility only when explicitly configured', async () => {
    const result = await sendAuthActionEmail(
      { DB: new FakeDeliveryDatabase().asD1Database(), AUTH_EMAIL_DELIVERY_MODE: 'manual_beta' },
      baseIssue('password_reset'),
    );

    expect(result).toMatchObject({
      mode: 'manual_beta',
      token: baseIssue('password_reset').token,
    });
  });

  it('consumes tokens and compensates password reset state on send failure', async () => {
    const database = new FakeDeliveryDatabase();

    await expect(
      sendAuthActionEmail(
        {
          DB: database.asD1Database(),
          AUTH_EMAIL: {
            send: async () => {
              throw { code: 'E_RATE_LIMIT_EXCEEDED' };
            },
          },
          AUTH_EMAIL_DELIVERY_MODE: 'email',
          AUTH_EMAIL_FROM: 'noreply@example.com',
        },
        baseIssue('password_reset'),
      ),
    ).rejects.toEqual(new AuthEmailDeliveryError(429, 'auth_email_rate_limited', 'E_RATE_LIMIT_EXCEEDED'));

    expect(database.statements.some((statement) => statement.query.includes('UPDATE auth_action_tokens'))).toBe(true);
    expect(
      database.statements.some(
        (statement) =>
          statement.query.includes('UPDATE auth_credentials') &&
          statement.query.includes('active_password_reset_token_id = ?') &&
          statement.query.includes('must_reset_password = 0'),
      ),
    ).toBe(true);
    const auditInsert = database.statements.find((statement) =>
      statement.query.includes('INSERT INTO audit_logs'),
    );
    expect(JSON.parse(String(auditInsert?.bindings[9]))).toMatchObject({
      tokenConsumedByFailure: true,
      passwordResetCompensated: true,
      superseded: false,
    });
  });

  it('requires the delivery failed mutation to change exactly one row', async () => {
    const database = new FakeDeliveryDatabase({
      changesForQuery: (query) =>
        query.includes('UPDATE auth_action_deliveries') ? 0 : 1,
    });

    await expect(
      sendAuthActionEmail(
        {
          DB: database.asD1Database(),
          AUTH_EMAIL: {
            send: async () => {
              throw { code: 'E_INTERNAL_SERVER_ERROR' };
            },
          },
          AUTH_EMAIL_DELIVERY_MODE: 'email',
          AUTH_EMAIL_FROM: 'noreply@example.com',
        },
        baseIssue('invite'),
      ),
    ).rejects.toEqual(new AuthEmailDeliveryError(503, 'auth_email_delivery_compensation_failed'));
    expect(database.auditRunAttempts).toBe(0);
  });

  it('keeps compensation when audit retries degrade and returns the original send error', async () => {
    const database = new FakeDeliveryDatabase({
      auditRunFailures: 3,
      changesForQuery: (query) =>
        query.includes('UPDATE auth_action_deliveries') ? 1 : 0,
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      sendAuthActionEmail(
        {
          DB: database.asD1Database(),
          AUTH_EMAIL: {
            send: async () => {
              throw { code: 'E_RATE_LIMIT_EXCEEDED' };
            },
          },
          AUTH_EMAIL_DELIVERY_MODE: 'email',
          AUTH_EMAIL_FROM: 'noreply@example.com',
        },
        baseIssue('password_reset'),
      ),
    ).rejects.toEqual(
      new AuthEmailDeliveryError(429, 'auth_email_rate_limited', 'E_RATE_LIMIT_EXCEEDED'),
    );

    expect(database.auditRunAttempts).toBe(3);
    expect(database.batchQueries[0]).not.toContain(expect.stringContaining('INSERT INTO audit_logs'));
    const auditInserts = database.statements.filter((statement) =>
      statement.query.includes('INSERT INTO audit_logs'),
    );
    expect(auditInserts).toHaveLength(3);
    expect(JSON.parse(String(auditInserts[0]?.bindings[9]))).toMatchObject({
      tokenConsumedByFailure: false,
      passwordResetCompensated: false,
      superseded: true,
    });
    expect(consoleError).toHaveBeenCalledWith(
      JSON.stringify({ message: 'auth_delivery_failure_audit_degraded' }),
    );
    expect(String(consoleError.mock.calls[0])).not.toContain(baseIssue('password_reset').token);
    expect(String(consoleError.mock.calls[0])).not.toContain('user@example.com');
    consoleError.mockRestore();
  });

  it('does not fail the API when accepted tracking update degrades', async () => {
    const database = new FakeDeliveryDatabase({ failBatchContaining: "status = 'accepted'" });

    await expect(
      sendAuthActionEmail(
        {
          DB: database.asD1Database(),
          AUTH_EMAIL: { send: async () => ({ messageId: 'cf-message-id' }) },
          AUTH_EMAIL_DELIVERY_MODE: 'email',
          AUTH_EMAIL_FROM: 'noreply@example.com',
        },
        baseIssue('invite'),
      ),
    ).resolves.toMatchObject({ mode: 'email', status: 'accepted', trackingDegraded: true });
  });
});

function baseIssue(type: ActionTokenIssueResult['type']): ActionTokenIssueResult {
  return {
    type,
    token: 't'.repeat(43),
    tokenId: '00000000-0000-4000-8000-000000000101',
    deliveryId: '00000000-0000-4000-8000-000000000102',
    tenantId: '00000000-0000-4000-8000-000000000001',
    expiresAt: '2026-07-18T01:00:00.000Z',
    membershipId: '00000000-0000-4000-8000-000000000005',
    userId: '00000000-0000-4000-8000-000000000004',
    organizationId: '00000000-0000-4000-8000-000000000002',
    recipientEmail: 'user@example.com',
    recipientDisplayName: 'User',
  };
}

interface CapturedStatement {
  query: string;
  bindings: unknown[];
}

class FakeDeliveryDatabase {
  readonly statements: CapturedStatement[] = [];
  readonly batchQueries: string[][] = [];
  auditRunAttempts = 0;

  constructor(
    private readonly options: {
      failBatchContaining?: string;
      auditRunFailures?: number;
      changesForQuery?: (query: string) => number;
    } = {},
  ) {}

  asD1Database(): D1Database {
    return {
      prepare: (query: string) => this.prepare(query),
      batch: async (statements: D1PreparedStatement[]) => {
        const queries = statements.map((statement) =>
          (statement as unknown as { query: string }).query,
        );
        this.batchQueries.push(queries);
        if (
          this.options.failBatchContaining &&
          queries.some((query) => query.includes(this.options.failBatchContaining ?? ''))
        ) {
          throw new Error('tracking_failed');
        }
        return queries.map((query) => d1Result(this.options.changesForQuery?.(query) ?? 1));
      },
    } as unknown as D1Database;
  }

  private prepare(query: string): D1PreparedStatement {
    const statement: CapturedStatement = { query, bindings: [] };
    this.statements.push(statement);
    const fakeStatement = {
      query,
      bind: (...values: unknown[]) => {
        statement.bindings = values;
        return fakeStatement;
      },
      first: async () => null,
      run: async () => {
        if (query.includes('INSERT INTO audit_logs')) {
          this.auditRunAttempts += 1;
          if (this.auditRunAttempts <= (this.options.auditRunFailures ?? 0)) {
            throw new Error('audit_sequence_conflict');
          }
        }
        return d1Result(this.options.changesForQuery?.(query) ?? 1);
      },
    };
    return fakeStatement as unknown as D1PreparedStatement;
  }
}

function d1Result(changes: number): D1Result<unknown> {
  return {
    success: true,
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: 0,
      rows_written: changes,
      last_row_id: 0,
      changed_db: changes > 0,
      changes,
    },
    results: [],
  };
}
