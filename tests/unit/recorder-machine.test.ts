import { describe, expect, it } from 'vitest';
import {
  canStartRecording,
  initialRecorderState,
  isBusy,
  recorderReducer,
  type RecorderState,
} from '../../src/mobile/lib/recorder-machine';

function advance(events: Parameters<typeof recorderReducer>[1][]): RecorderState {
  return events.reduce(recorderReducer, initialRecorderState());
}

describe('recorderReducer', () => {
  it('walks the happy path idle → done', () => {
    let s = advance([{ type: 'LOGIN_OK' }]);
    expect(s.status).toBe('ready');

    s = recorderReducer(s, { type: 'GRANT_CONSENT' });
    expect(s.status).toBe('consented');
    expect(canStartRecording(s)).toBe(true);

    s = recorderReducer(s, { type: 'START' });
    expect(s.status).toBe('recording');

    s = recorderReducer(s, { type: 'STOP' });
    expect(s.status).toBe('recorded');
    expect(s.hasRecording).toBe(true);

    s = recorderReducer(s, { type: 'UPLOAD' });
    expect(isBusy(s)).toBe(true);

    s = recorderReducer(s, { type: 'UPLOADED', callId: 'c1', sttJobId: 'j1' });
    expect(s.status).toBe('processing');
    expect(s.callId).toBe('c1');

    s = recorderReducer(s, { type: 'PROCESSED', transcriptCount: 42 });
    expect(s.status).toBe('done');
    expect(s.transcriptCount).toBe(42);
  });

  it('hard-gates recording on consent', () => {
    const ready = advance([{ type: 'LOGIN_OK' }]);
    // START without consent is a no-op.
    expect(recorderReducer(ready, { type: 'START' }).status).toBe('ready');
    expect(canStartRecording(ready)).toBe(false);
  });

  it('revoking consent returns to ready and blocks recording', () => {
    let s = advance([{ type: 'LOGIN_OK' }, { type: 'GRANT_CONSENT' }]);
    s = recorderReducer(s, { type: 'REVOKE_CONSENT' });
    expect(s.status).toBe('ready');
    expect(s.consentGranted).toBe(false);
  });

  it('locks product selection once recording starts', () => {
    let s = advance([{ type: 'LOGIN_OK' }, { type: 'GRANT_CONSENT' }, { type: 'START' }]);
    s = recorderReducer(s, { type: 'SELECT_PRODUCT', productId: 'hojokin' });
    expect(s.productId).toBe('real_estate'); // unchanged while recording
  });

  it('allows product change before consent', () => {
    let s = advance([{ type: 'LOGIN_OK' }]);
    s = recorderReducer(s, { type: 'SELECT_PRODUCT', productId: 'kenko_keiei' });
    expect(s.productId).toBe('kenko_keiei');
  });

  it('captures errors and resets for the next visit keeping product', () => {
    let s = advance([
      { type: 'LOGIN_OK' },
      { type: 'GRANT_CONSENT' },
      { type: 'START' },
      { type: 'STOP' },
      { type: 'UPLOAD' },
    ]);
    s = recorderReducer(s, { type: 'FAIL', error: 'network down' });
    expect(s.status).toBe('error');
    expect(s.error).toBe('network down');

    s = recorderReducer(s, { type: 'RESET' });
    expect(s.status).toBe('ready');
    expect(s.hasRecording).toBe(false);
    expect(s.error).toBeNull();
  });

  it('logout clears everything', () => {
    const s = advance([{ type: 'LOGIN_OK' }, { type: 'GRANT_CONSENT' }, { type: 'LOGOUT' }]);
    expect(s.status).toBe('idle');
    expect(s.consentGranted).toBe(false);
  });
});
