import pino from 'pino';
import { app } from 'electron';
import { maskPiiInObject } from './services/pii';

/**
 * Pino logger. Per PRD §29:
 * - JSON Lines output.
 * - PII auto-masking on serialization.
 * - During calls: info+ only (debug suppressed for safety).
 */

const baseLevel = process.env.NODE_ENV === 'test' ? 'silent' : app?.isPackaged ? 'info' : 'debug';

export const logger = pino({
  level: baseLevel,
  base: { app: 'sales-talk', version: app?.getVersion?.() ?? 'test' },
  formatters: {
    log(obj) {
      return maskPiiInObject(obj) as Record<string, unknown>;
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
