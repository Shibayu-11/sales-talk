import { PII_PATTERNS } from '@shared/constants';

const MAX_RECURSION_DEPTH = 8;

const PII_KEY_PATTERN =
  /(^|_)(name|fullName|email|phone|tel|address|customer|company|transcript|text|message|script)($|_)/i;

export function maskPiiInText(value: string): string {
  return value
    .replace(PII_PATTERNS.phoneJp, '[redacted-phone]')
    .replace(PII_PATTERNS.email, '[redacted-email]')
    .replace(PII_PATTERNS.creditCard, '[redacted-card]');
}

export function maskPiiInObject(value: unknown): unknown {
  return maskUnknown(value, 0, undefined);
}

function maskUnknown(value: unknown, depth: number, key: string | undefined): unknown {
  if (depth > MAX_RECURSION_DEPTH) return '[redacted-depth-limit]';
  if (typeof value === 'string') {
    const masked = maskPiiInText(value);
    return key && PII_KEY_PATTERN.test(key) ? masked : masked;
  }
  if (typeof value !== 'object' || value === null) return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: maskPiiInText(value.message),
      stack: value.stack ? maskPiiInText(value.stack) : undefined,
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskUnknown(item, depth + 1, key));
  }

  const masked: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    masked[entryKey] = maskUnknown(entryValue, depth + 1, entryKey);
  }
  return masked;
}
