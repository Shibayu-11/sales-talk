import { describe, expect, it } from 'vitest';
import { maskPiiInObject, maskPiiInText } from '../../src/main/services/pii';

describe('PII masking', () => {
  it('masks email, Japanese phone numbers, and card-like numbers in text', () => {
    const masked = maskPiiInText(
      '連絡先は yamada@example.com / 090-1234-5678 / 4111 1111 1111 1111 です。',
    );

    expect(masked).toContain('[redacted-email]');
    expect(masked).toContain('[redacted-phone]');
    expect(masked).toContain('[redacted-card]');
    expect(masked).not.toContain('yamada@example.com');
  });

  it('recursively masks nested log payloads', () => {
    const masked = maskPiiInObject({
      transcript: '田中さんのメールは tanaka@example.com です',
      nested: { phone: '03-1234-5678' },
      rows: ['08012345678'],
    });

    expect(masked).toEqual({
      transcript: '田中さんのメールは [redacted-email] です',
      nested: { phone: '[redacted-phone]' },
      rows: ['[redacted-phone]'],
    });
  });
});
