import pino from 'pino';
import { app } from 'electron';
import { PII_PATTERNS } from '@shared/constants';

/**
 * Pino logger. Per PRD §29:
 * - JSON Lines output.
 * - PII auto-masking on serialization.
 * - During calls: info+ only (debug suppressed for safety).
 */

function maskPii(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value
    .replace(PII_PATTERNS.phoneJp, '[redacted-phone]')
    .replace(PII_PATTERNS.email, '[redacted-email]')
    .replace(PII_PATTERNS.creditCard, '[redacted-card]');
}

const baseLevel = app.isPackaged ? 'info' : 'debug';

export const logger = pino({
  level: baseLevel,
  base: { app: 'sales-talk', version: app.getVersion() },
  formatters: {
    log(obj) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        out[k] = maskPii(v);
      }
      return out;
    },
  },
  redact: {
    paths: [
      '*.apiKey',
      '*.api_key',
      '*.token',
      '*.password',
      '*.authorization',
      'headers.authorization',
    ],
    censor: '[redacted]',
  },
});

/** Switch to call-mode log level (info+). Per PRD §29.4 */
export function setCallModeLogging(inCall: boolean): void {
  logger.level = inCall ? 'info' : baseLevel;
}
