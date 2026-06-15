import { describe, expect, it } from 'vitest';
import type { DetectedObjection, ObjectionResponse } from '../../src/shared/types';
import {
  hasRiskFlags,
  initialOverlayState,
  overlayReducer,
  type OverlayState,
} from '../../src/renderer/overlay/src/lib/overlay-state';

function objection(id: string): DetectedObjection {
  return { id, type: 'price', confidence: 0.8, triggerText: '価格が高い', detectedAt: 1 };
}

function response(objectionId: string, riskFlags: string[] = []): ObjectionResponse {
  return {
    id: `r-${objectionId}`,
    objectionId,
    peak: '比較で整理',
    summary: ['総額で比較'],
    fullScript: '…',
    reasoning: '…',
    notes: [],
    riskFlags,
    sources: [],
    generatedAtMs: 1,
  };
}

describe('overlayReducer', () => {
  it('resets to L1 on a new objection', () => {
    const next = overlayReducer(initialOverlayState, { type: 'DETECTED', objection: objection('a') });
    expect(next.layer).toBe(1);
    expect(next.objection?.id).toBe('a');
    expect(next.response).toBeNull();
  });

  it('auto-advances to L2 when the response arrives and user is still on L1', () => {
    let state = overlayReducer(initialOverlayState, { type: 'DETECTED', objection: objection('a') });
    state = overlayReducer(state, { type: 'RESPONSE', response: response('a') });
    expect(state.layer).toBe(2);
    expect(state.response?.objectionId).toBe('a');
  });

  it('does NOT yank the user from L3 back when the response arrives', () => {
    let state = overlayReducer(initialOverlayState, { type: 'DETECTED', objection: objection('a') });
    state = overlayReducer(state, { type: 'SET_LAYER', layer: 3 });
    state = overlayReducer(state, { type: 'RESPONSE', response: response('a') });
    expect(state.layer).toBe(3); // preserved
    expect(state.response).not.toBeNull();
  });

  it('ignores a response for a superseded objection', () => {
    let state = overlayReducer(initialOverlayState, { type: 'DETECTED', objection: objection('a') });
    state = overlayReducer(state, { type: 'DETECTED', objection: objection('b') });
    state = overlayReducer(state, { type: 'RESPONSE', response: response('a') }); // stale
    expect(state.response).toBeNull();
    expect(state.objection?.id).toBe('b');
  });

  it('keeps the current layer/response when the same objection is re-detected', () => {
    let state = overlayReducer(initialOverlayState, { type: 'DETECTED', objection: objection('a') });
    state = overlayReducer(state, { type: 'RESPONSE', response: response('a') });
    state = overlayReducer(state, { type: 'SET_LAYER', layer: 3 });
    const refined: DetectedObjection = { ...objection('a'), confidence: 0.95 };
    state = overlayReducer(state, { type: 'DETECTED', objection: refined });
    expect(state.layer).toBe(3); // not reset
    expect(state.response).not.toBeNull(); // not cleared
    expect(state.objection?.confidence).toBe(0.95); // updated
  });

  it('clears objection and response on cancel', () => {
    let state = overlayReducer(initialOverlayState, { type: 'DETECTED', objection: objection('a') });
    state = overlayReducer(state, { type: 'CANCELLED' });
    expect(state.objection).toBeNull();
    expect(state.response).toBeNull();
  });

  it('surfaces risk flags regardless of layer', () => {
    let state: OverlayState = overlayReducer(initialOverlayState, {
      type: 'DETECTED',
      objection: objection('a'),
    });
    expect(hasRiskFlags(state)).toBe(false);
    state = overlayReducer(state, {
      type: 'RESPONSE',
      response: response('a', ['requires_human_review']),
    });
    expect(hasRiskFlags(state)).toBe(true);
  });
});
