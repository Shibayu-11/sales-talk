import { describe, expect, it } from 'vitest';
import {
  completedStepCount,
  isOnboardingComplete,
  resolveCurrentStep,
  type OnboardingState,
} from '../../src/renderer/control/src/lib/onboarding';

const empty: OnboardingState = {
  permissions: null,
  anthropicKeyConfigured: false,
  productSelected: false,
};

describe('onboarding step resolution', () => {
  it('starts at permissions when nothing is set up', () => {
    expect(resolveCurrentStep(empty)).toBe('permissions');
    expect(isOnboardingComplete(empty)).toBe(false);
    expect(completedStepCount(empty)).toBe(0);
  });

  it('requires both screen and microphone before advancing', () => {
    expect(
      resolveCurrentStep({ ...empty, permissions: { screen: true, microphone: false } }),
    ).toBe('permissions');
    expect(
      resolveCurrentStep({ ...empty, permissions: { screen: true, microphone: true } }),
    ).toBe('apiKey');
  });

  it('advances to product after permissions and API key', () => {
    const state: OnboardingState = {
      permissions: { screen: true, microphone: true },
      anthropicKeyConfigured: true,
      productSelected: false,
    };
    expect(resolveCurrentStep(state)).toBe('product');
    expect(completedStepCount(state)).toBe(2);
  });

  it('is complete only when all three steps are satisfied', () => {
    const state: OnboardingState = {
      permissions: { screen: true, microphone: true },
      anthropicKeyConfigured: true,
      productSelected: true,
    };
    expect(resolveCurrentStep(state)).toBe('done');
    expect(isOnboardingComplete(state)).toBe(true);
    expect(completedStepCount(state)).toBe(3);
  });

  it('does not skip an earlier incomplete step even if a later one is done', () => {
    // API key set but permissions missing → still gated on permissions.
    const state: OnboardingState = {
      permissions: { screen: false, microphone: false },
      anthropicKeyConfigured: true,
      productSelected: true,
    };
    expect(resolveCurrentStep(state)).toBe('permissions');
  });
});
