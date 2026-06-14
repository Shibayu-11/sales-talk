import type { PermissionState } from '@shared/types';

/**
 * First-run onboarding step model. Pure so the gating rules are unit-testable
 * independent of React. Steps run in order; each step's `complete` predicate
 * decides whether the user may advance.
 */

export type OnboardingStepId = 'permissions' | 'apiKey' | 'product' | 'done';

export interface OnboardingState {
  permissions: PermissionState | null;
  anthropicKeyConfigured: boolean;
  productSelected: boolean;
}

export const ONBOARDING_STEP_ORDER: OnboardingStepId[] = ['permissions', 'apiKey', 'product', 'done'];

export function isPermissionsStepComplete(state: OnboardingState): boolean {
  return Boolean(state.permissions?.screen && state.permissions.microphone);
}

export function isApiKeyStepComplete(state: OnboardingState): boolean {
  return state.anthropicKeyConfigured;
}

export function isProductStepComplete(state: OnboardingState): boolean {
  return state.productSelected;
}

export function isStepComplete(step: OnboardingStepId, state: OnboardingState): boolean {
  switch (step) {
    case 'permissions':
      return isPermissionsStepComplete(state);
    case 'apiKey':
      return isApiKeyStepComplete(state);
    case 'product':
      return isProductStepComplete(state);
    case 'done':
      return true;
  }
}

/** The first incomplete step, or 'done' when everything required is satisfied. */
export function resolveCurrentStep(state: OnboardingState): OnboardingStepId {
  for (const step of ONBOARDING_STEP_ORDER) {
    if (step === 'done') {
      return 'done';
    }
    if (!isStepComplete(step, state)) {
      return step;
    }
  }
  return 'done';
}

export function isOnboardingComplete(state: OnboardingState): boolean {
  return resolveCurrentStep(state) === 'done';
}

/** Progress as a 0-based index into the 3 actionable steps (for the stepper UI). */
export function completedStepCount(state: OnboardingState): number {
  return [isPermissionsStepComplete, isApiKeyStepComplete, isProductStepComplete].filter((check) =>
    check(state),
  ).length;
}
