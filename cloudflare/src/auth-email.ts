import type { D1Database } from '@cloudflare/workers-types';
import {
  recordAuthActionDeliveryAccepted,
  recordAuthActionDeliveryCancelled,
  recordAuthActionDeliveryFailed,
  type ActionTokenIssueResult,
} from './account-lifecycle';

export type AuthEmailDeliveryMode = 'email' | 'manual_beta';

export type PublicAuthActionDeliveryResult =
  | {
      mode: 'manual_beta';
      type: ActionTokenIssueResult['type'];
      token: string;
      expiresAt: string;
      membershipId: string;
      userId: string;
      organizationId: string;
      deliveryId: string;
    }
  | {
      mode: 'email';
      type: ActionTokenIssueResult['type'];
      status: 'accepted';
      expiresAt: string;
      membershipId: string;
      userId: string;
      organizationId: string;
      deliveryId: string;
      recipient: { emailMasked: string };
      providerMessageId?: string | undefined;
      trackingDegraded: boolean;
    };

interface AuthEmailEnv {
  DB: D1Database;
  AUTH_EMAIL?: {
    send(message: AuthEmailMessage): Promise<{ messageId?: string | undefined }>;
  } | undefined;
  AUTH_EMAIL_DELIVERY_MODE?: string | undefined;
  AUTH_EMAIL_FROM?: string | undefined;
  AUTH_EMAIL_FROM_NAME?: string | undefined;
}

interface AuthEmailMessage {
  to: string;
  from: string | { email: string; name: string };
  subject: string;
  html: string;
  text: string;
}

interface AuthEmailContent {
  subject: string;
  html: string;
  text: string;
}

const PRODUCT_NAME = 'SalesTalk';

export class AuthEmailDeliveryError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly providerCode?: string | undefined,
  ) {
    super(message);
  }
}

export function resolveAuthEmailDeliveryMode(env: {
  AUTH_EMAIL_DELIVERY_MODE?: string | undefined;
}): AuthEmailDeliveryMode {
  const mode = env.AUTH_EMAIL_DELIVERY_MODE?.trim();
  if (mode === 'manual_beta') {
    return 'manual_beta';
  }
  if (!mode || mode === 'email') {
    return 'email';
  }
  throw new AuthEmailDeliveryError(503, 'auth_email_delivery_mode_invalid');
}

export function assertAuthEmailDeliveryConfigured(env: AuthEmailEnv): AuthEmailDeliveryMode {
  const mode = resolveAuthEmailDeliveryMode(env);
  if (mode === 'email') {
    if (!env.AUTH_EMAIL) {
      throw new AuthEmailDeliveryError(503, 'auth_email_binding_not_configured');
    }
    resolveAuthEmailSender(env);
  }
  return mode;
}

export async function sendAuthActionEmail(
  env: AuthEmailEnv,
  issue: ActionTokenIssueResult,
  now = new Date(),
): Promise<PublicAuthActionDeliveryResult> {
  const mode = assertAuthEmailDeliveryConfigured(env);
  if (mode === 'manual_beta') {
    await recordAuthActionDeliveryCancelled(env.DB, {
      type: issue.type,
      tokenId: issue.tokenId,
      deliveryId: issue.deliveryId,
      tenantId: issue.tenantId,
      organizationId: issue.organizationId,
      reason: 'manual_beta',
      cancelledAt: now,
    });
    return {
      mode,
      type: issue.type,
      token: issue.token,
      expiresAt: issue.expiresAt,
      membershipId: issue.membershipId,
      userId: issue.userId,
      organizationId: issue.organizationId,
      deliveryId: issue.deliveryId,
    };
  }

  let messageId: string | null = null;
  try {
    const sender = resolveAuthEmailSender(env);
    const binding = env.AUTH_EMAIL;
    if (!binding) throw new AuthEmailDeliveryError(503, 'auth_email_binding_not_configured');
    const content = renderAuthActionEmail(issue);
    const response = await binding.send({
      to: issue.recipientEmail,
      from: sender,
      subject: content.subject,
      html: content.html,
      text: content.text,
    });
    messageId = response.messageId ?? null;
  } catch (error) {
    const deliveryError = normalizeCloudflareEmailError(error);
    try {
      await recordAuthActionDeliveryFailed(env.DB, {
        type: issue.type,
        tokenId: issue.tokenId,
        deliveryId: issue.deliveryId,
        tenantId: issue.tenantId,
        organizationId: issue.organizationId,
        userId: issue.userId,
        errorCode: deliveryError.message,
        failedAt: now,
      });
    } catch {
      throw new AuthEmailDeliveryError(503, 'auth_email_delivery_compensation_failed');
    }
    throw deliveryError;
  }

  let trackingDegraded = false;
  try {
    await recordAuthActionDeliveryAccepted(env.DB, {
      type: issue.type,
      tokenId: issue.tokenId,
      deliveryId: issue.deliveryId,
      tenantId: issue.tenantId,
      organizationId: issue.organizationId,
      providerMessageId: messageId,
      acceptedAt: now,
    });
  } catch {
    trackingDegraded = true;
  }

  return {
    mode,
    type: issue.type,
    status: 'accepted',
    expiresAt: issue.expiresAt,
    membershipId: issue.membershipId,
    userId: issue.userId,
    organizationId: issue.organizationId,
    deliveryId: issue.deliveryId,
    recipient: { emailMasked: maskEmailAddress(issue.recipientEmail) },
    providerMessageId: messageId ?? undefined,
    trackingDegraded,
  };
}

export function renderAuthActionEmail(issue: ActionTokenIssueResult): AuthEmailContent {
  const actionLabel = issue.type === 'invite' ? '招待' : 'パスワード再設定';
  const title =
    issue.type === 'invite'
      ? `${PRODUCT_NAME} への招待`
      : `${PRODUCT_NAME} パスワード再設定`;
  const escapedDisplayName = escapeHtml(issue.recipientDisplayName);
  const escapedToken = escapeHtml(issue.token);
  const escapedExpiresAt = escapeHtml(formatJapaneseDateTime(issue.expiresAt));
  const text = [
    `${issue.recipientDisplayName} 様`,
    '',
    `${PRODUCT_NAME} の${actionLabel}手続きを開始するためのワンタイム token をお送りします。`,
    'SalesTalk アプリの設定画面で「メールで届いた token」欄に以下の token を貼り付け、新しいパスワードを設定してください。',
    '',
    issue.token,
    '',
    `有効期限: ${formatJapaneseDateTime(issue.expiresAt)}`,
    '',
    '安全のため、このメールには token 入りの deep link は含めていません。',
    'このメールに心当たりがない場合は、管理者に連絡してください。',
  ].join('\n');
  const html = [
    '<!doctype html>',
    '<html lang="ja">',
    '<body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;line-height:1.7;color:#18181b;">',
    `<h1 style="font-size:18px;">${escapeHtml(title)}</h1>`,
    `<p>${escapedDisplayName} 様</p>`,
    `<p>${PRODUCT_NAME} の${escapeHtml(actionLabel)}手続きを開始するためのワンタイム token をお送りします。</p>`,
    '<p>SalesTalk アプリの設定画面で「メールで届いた token」欄に以下の token を貼り付け、新しいパスワードを設定してください。</p>',
    `<pre style="white-space:pre-wrap;word-break:break-all;border:1px solid #d4d4d8;border-radius:8px;padding:12px;background:#fafafa;">${escapedToken}</pre>`,
    `<p><strong>有効期限:</strong> ${escapedExpiresAt}</p>`,
    '<p>安全のため、このメールには token 入りの deep link は含めていません。</p>',
    '<p>このメールに心当たりがない場合は、管理者に連絡してください。</p>',
    '</body>',
    '</html>',
  ].join('');
  return { subject: title, html, text };
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function maskEmailAddress(email: string): string {
  const [localPart = '', domainPart = ''] = email.split('@');
  const [domainName = '', ...domainRest] = domainPart.split('.');
  const local = localPart ? `${localPart[0]}***` : '***';
  const domain = domainName ? `${domainName[0]}***` : '***';
  const suffix = domainRest.length > 0 ? `.${domainRest.at(-1)}` : '';
  return `${local}@${domain}${suffix}`;
}

export function normalizeCloudflareEmailError(error: unknown): AuthEmailDeliveryError {
  if (error instanceof AuthEmailDeliveryError) {
    return error;
  }
  const providerCode = providerErrorCode(error);
  const message = providerCode ? providerErrorMessage(providerCode) : 'auth_email_send_failed';
  return new AuthEmailDeliveryError(providerErrorStatus(providerCode), message, providerCode ?? undefined);
}

function resolveAuthEmailSender(env: AuthEmailEnv): string | { email: string; name: string } {
  const email = env.AUTH_EMAIL_FROM?.trim();
  if (!email) {
    throw new AuthEmailDeliveryError(503, 'auth_email_from_not_configured');
  }
  const name = env.AUTH_EMAIL_FROM_NAME?.trim();
  if (name) {
    return { email, name };
  }
  return email;
}

function providerErrorCode(error: unknown): string | null {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

function providerErrorStatus(code: string | null): number {
  switch (code) {
    case 'E_VALIDATION_ERROR':
    case 'E_FIELD_MISSING':
    case 'E_TOO_MANY_RECIPIENTS':
    case 'E_TOO_MANY_ATTACHMENTS':
    case 'E_SENDER_NOT_VERIFIED':
    case 'E_RECIPIENT_NOT_ALLOWED':
    case 'E_RECIPIENT_SUPPRESSED':
    case 'E_SENDER_DOMAIN_NOT_AVAILABLE':
    case 'E_CONTENT_TOO_LARGE':
    case 'E_HEADER_NOT_ALLOWED':
    case 'E_HEADER_USE_API_FIELD':
    case 'E_HEADER_VALUE_INVALID':
    case 'E_HEADER_VALUE_TOO_LONG':
    case 'E_HEADER_NAME_INVALID':
    case 'E_HEADERS_TOO_LARGE':
    case 'E_HEADERS_TOO_MANY':
      return 422;
    case 'E_RATE_LIMIT_EXCEEDED':
    case 'E_DAILY_LIMIT_EXCEEDED':
      return 429;
    default:
      return 503;
  }
}

function providerErrorMessage(code: string): string {
  switch (code) {
    case 'E_RATE_LIMIT_EXCEEDED':
    case 'E_DAILY_LIMIT_EXCEEDED':
      return 'auth_email_rate_limited';
    case 'E_SENDER_NOT_VERIFIED':
    case 'E_SENDER_DOMAIN_NOT_AVAILABLE':
      return 'auth_email_sender_not_verified';
    case 'E_RECIPIENT_NOT_ALLOWED':
    case 'E_RECIPIENT_SUPPRESSED':
      return 'auth_email_recipient_rejected';
    case 'E_VALIDATION_ERROR':
    case 'E_FIELD_MISSING':
    case 'E_TOO_MANY_RECIPIENTS':
    case 'E_TOO_MANY_ATTACHMENTS':
    case 'E_CONTENT_TOO_LARGE':
    case 'E_HEADER_NOT_ALLOWED':
    case 'E_HEADER_USE_API_FIELD':
    case 'E_HEADER_VALUE_INVALID':
    case 'E_HEADER_VALUE_TOO_LONG':
    case 'E_HEADER_NAME_INVALID':
    case 'E_HEADERS_TOO_LARGE':
    case 'E_HEADERS_TOO_MANY':
      return 'auth_email_validation_failed';
    default:
      return 'auth_email_temporarily_unavailable';
  }
}

function formatJapaneseDateTime(value: string): string {
  return new Date(value).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}
