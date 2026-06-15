import type { DetectedObjection, ObjectionResponse } from '@shared/types';

/**
 * Pure overlay view state + reducer. Extracted from the component so the
 * layer-navigation rules (which are easy to get wrong during a live call) are
 * unit-testable.
 *
 * Design goals:
 * - A NEW objection resets to L1 (the at-a-glance peek).
 * - The response for the CURRENT objection auto-advances to L2 only if the user
 *   is still on L1 — never yank someone who has navigated to L3 to read the script.
 * - A response for a stale/superseded objection is ignored.
 */

export type OverlayLayer = 1 | 2 | 3;

export interface OverlayState {
  objection: DetectedObjection | null;
  response: ObjectionResponse | null;
  layer: OverlayLayer;
}

export type OverlayEvent =
  | { type: 'DETECTED'; objection: DetectedObjection }
  | { type: 'RESPONSE'; response: ObjectionResponse }
  | { type: 'CANCELLED' }
  | { type: 'SET_LAYER'; layer: OverlayLayer };

export const DEFAULT_LAYER: OverlayLayer = 2;

export const initialOverlayState: OverlayState = {
  objection: null,
  response: null,
  layer: DEFAULT_LAYER,
};

export function overlayReducer(state: OverlayState, event: OverlayEvent): OverlayState {
  switch (event.type) {
    case 'DETECTED': {
      const isSameObjection = state.objection?.id === event.objection.id;
      if (isSameObjection) {
        // Same objection updated (e.g. confidence refined) — keep layer/response.
        return { ...state, objection: event.objection };
      }
      // New objection: reset to the at-a-glance peek.
      return { objection: event.objection, response: null, layer: 1 };
    }
    case 'RESPONSE': {
      // Ignore a response that belongs to a superseded objection.
      if (!state.objection || event.response.objectionId !== state.objection.id) {
        return state;
      }
      // Auto-advance to L2 only if the user hasn't navigated deeper themselves.
      const layer: OverlayLayer = state.layer === 1 ? 2 : state.layer;
      return { ...state, response: event.response, layer };
    }
    case 'CANCELLED':
      return { objection: null, response: null, layer: state.layer };
    case 'SET_LAYER':
      return { ...state, layer: event.layer };
  }
}

/** Risk flags should surface regardless of which layer is shown. */
export function hasRiskFlags(state: OverlayState): boolean {
  return (state.response?.riskFlags.length ?? 0) > 0;
}
