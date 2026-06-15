import type { ProductId } from '@shared/types';

/**
 * 訪問営業のモバイル録音フロー(PWA)の純粋ステートマシン。
 * 録音同意を録音開始の前提ゲートにする(2軸計画 §9: 無断録音への懸念対策)。
 * UI / MediaRecorder / fetch から切り離してテスト可能にする。
 *
 * 状態遷移:
 *   idle → (LOGIN_OK) → ready
 *   ready → (GRANT_CONSENT) → consented
 *   consented → (START) → recording
 *   recording → (STOP, blob) → recorded
 *   recorded → (UPLOAD) → uploading → (UPLOADED, jobId) → processing
 *   processing → (PROCESSED, count) → done
 *   any → (FAIL) → error;  error/done → (RESET) → ready
 */

export type RecorderStatus =
  | 'idle'
  | 'ready'
  | 'consented'
  | 'recording'
  | 'recorded'
  | 'uploading'
  | 'processing'
  | 'done'
  | 'error';

export interface RecorderState {
  status: RecorderStatus;
  productId: ProductId;
  consentGranted: boolean;
  /** Set once recording stops; the audio to upload. */
  hasRecording: boolean;
  callId: string | null;
  sttJobId: string | null;
  transcriptCount: number | null;
  error: string | null;
}

export type RecorderEvent =
  | { type: 'LOGIN_OK' }
  | { type: 'LOGOUT' }
  | { type: 'SELECT_PRODUCT'; productId: ProductId }
  | { type: 'GRANT_CONSENT' }
  | { type: 'REVOKE_CONSENT' }
  | { type: 'START' }
  | { type: 'STOP' }
  | { type: 'UPLOAD' }
  | { type: 'UPLOADED'; callId: string; sttJobId: string }
  | { type: 'PROCESSED'; transcriptCount: number }
  | { type: 'FAIL'; error: string }
  | { type: 'RESET' };

export function initialRecorderState(productId: ProductId = 'real_estate'): RecorderState {
  return {
    status: 'idle',
    productId,
    consentGranted: false,
    hasRecording: false,
    callId: null,
    sttJobId: null,
    transcriptCount: null,
    error: null,
  };
}

export function recorderReducer(state: RecorderState, event: RecorderEvent): RecorderState {
  switch (event.type) {
    case 'LOGIN_OK':
      return state.status === 'idle' ? { ...state, status: 'ready' } : state;
    case 'LOGOUT':
      return initialRecorderState(state.productId);
    case 'SELECT_PRODUCT':
      // Product is locked once recording starts to keep the call's vertical consistent.
      return canSelectProduct(state.status)
        ? { ...state, productId: event.productId }
        : state;
    case 'GRANT_CONSENT':
      if (state.status !== 'ready') return state;
      return { ...state, consentGranted: true, status: 'consented' };
    case 'REVOKE_CONSENT':
      if (state.status !== 'consented') return state;
      return { ...state, consentGranted: false, status: 'ready' };
    case 'START':
      // Hard gate: cannot record without consent.
      if (state.status !== 'consented' || !state.consentGranted) return state;
      return { ...state, status: 'recording', error: null };
    case 'STOP':
      if (state.status !== 'recording') return state;
      return { ...state, status: 'recorded', hasRecording: true };
    case 'UPLOAD':
      if (state.status !== 'recorded') return state;
      return { ...state, status: 'uploading', error: null };
    case 'UPLOADED':
      if (state.status !== 'uploading') return state;
      return {
        ...state,
        status: 'processing',
        callId: event.callId,
        sttJobId: event.sttJobId,
      };
    case 'PROCESSED':
      if (state.status !== 'processing') return state;
      return { ...state, status: 'done', transcriptCount: event.transcriptCount };
    case 'FAIL':
      return { ...state, status: 'error', error: event.error };
    case 'RESET':
      // Keep login + product, drop the recording so a new visit can start.
      return {
        ...initialRecorderState(state.productId),
        status: 'ready',
      };
  }
}

function canSelectProduct(status: RecorderStatus): boolean {
  return status === 'ready' || status === 'consented';
}

/** Whether the big record button should be enabled (consent satisfied, not busy). */
export function canStartRecording(state: RecorderState): boolean {
  return state.status === 'consented' && state.consentGranted;
}

export function isBusy(state: RecorderState): boolean {
  return state.status === 'uploading' || state.status === 'processing';
}
