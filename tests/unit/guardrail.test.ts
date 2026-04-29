import { describe, expect, it } from 'vitest';
import { applyOutputGuardrail } from '../../src/main/services/guardrail';

describe('applyOutputGuardrail', () => {
  it('passes clean real estate responses unchanged', () => {
    const result = applyOutputGuardrail({
      productId: 'real_estate',
      text: '一般論として、立地・築年数次第で変動します。',
    });

    expect(result.allowed).toBe(true);
    expect(result.safeText).toBe('一般論として、立地・築年数次第で変動します。');
    expect(result.riskFlags).toEqual([]);
  });

  it('replaces subsidy acceptance guarantees with safe fallback', () => {
    const result = applyOutputGuardrail({
      productId: 'hojokin',
      text: 'この内容なら100%採択されます。',
    });

    expect(result.allowed).toBe(false);
    expect(result.safeText).toContain('公募要領を確認');
    expect(result.riskFlags).toContain('subsidy_acceptance_guarantee');
    expect(result.riskFlags).toContain('requires_human_review');
  });

  it('preserves existing risk flags and adds product-specific violations', () => {
    const result = applyOutputGuardrail({
      productId: 'kenko_keiei',
      text: 'この施策で離職率は必ず下がります。',
      riskFlags: ['model_self_reported_risk'],
    });

    expect(result.allowed).toBe(false);
    expect(result.riskFlags).toEqual(
      expect.arrayContaining([
        'model_self_reported_risk',
        'health_effect_guarantee',
        'requires_human_review',
      ]),
    );
  });
});
