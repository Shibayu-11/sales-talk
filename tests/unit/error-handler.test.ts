import { describe, expect, it, vi } from 'vitest';
import { ErrorHandler } from '../../src/main/services/error-handler';

describe('ErrorHandler', () => {
  it('scrubs PII before returning and notifying high severity errors', () => {
    const notify = vi.fn();
    const captureException = vi.fn();
    const handler = new ErrorHandler({ notify, captureException });

    const handled = handler.handle({
      severity: 'high',
      category: 'api',
      code: 'anthropic_auth_failed',
      message: 'APIキーを確認してください',
      recoverable: false,
      context: {
        customerEmail: 'customer@example.com',
        transcript: '電話番号は090-1234-5678です',
      },
    });

    expect(handled.context).toEqual({
      customerEmail: '[redacted-email]',
      transcript: '電話番号は[redacted-phone]です',
    });
    expect(notify).toHaveBeenCalledWith(handled);
    expect(captureException).toHaveBeenCalledWith(handled);
  });

  it('does not notify renderer for medium degradation', () => {
    const notify = vi.fn();
    const captureEvent = vi.fn();
    const handler = new ErrorHandler({ notify, captureEvent });

    handler.handle({
      severity: 'medium',
      category: 'database',
      code: 'cohere_search_failed',
      message: 'ナレッジ検索を一時停止しています',
      recoverable: true,
      recoveryAction: 'fallback',
    });

    expect(notify).not.toHaveBeenCalled();
    expect(captureEvent).toHaveBeenCalledWith(
      'system_degraded',
      expect.objectContaining({ code: 'cohere_search_failed' }),
    );
  });
});
