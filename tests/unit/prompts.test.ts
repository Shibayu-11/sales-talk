import { describe, expect, it } from 'vitest';
import {
  HAIKU_DETECTION_SYSTEM_PROMPT,
  buildResponseSystemPrompt,
} from '../../src/main/services/anthropic';
import { MEETING_MINUTES_SYSTEM_PROMPT } from '../../src/main/services/minutes-llm';

describe('HAIKU_DETECTION_SYSTEM_PROMPT', () => {
  it('includes few-shot examples and a confidence scale to curb false positives', () => {
    // Positive and negative examples both present.
    expect(HAIKU_DETECTION_SYSTEM_PROMPT).toContain('費用が高くて');
    expect(HAIKU_DETECTION_SYSTEM_PROMPT).toContain('"isObjection":false');
    expect(HAIKU_DETECTION_SYSTEM_PROMPT).toContain('予算を確認しておきます');
    // Confidence scale guidance.
    expect(HAIKU_DETECTION_SYSTEM_PROMPT).toContain('0.9-1.0');
  });
});

describe('buildResponseSystemPrompt', () => {
  it('injects product-specific proactive guardrails for each vertical', () => {
    expect(buildResponseSystemPrompt('real_estate')).toContain('宅建士');
    expect(buildResponseSystemPrompt('hojokin')).toContain('行政書士');
    expect(buildResponseSystemPrompt('kenko_keiei')).toContain('産業医');
  });

  it('flags hojokin as highest risk (subsidy fraud is legally serious)', () => {
    const prompt = buildResponseSystemPrompt('hojokin');
    expect(prompt).toContain('最高リスク');
    expect(prompt).toContain('採択を確約');
  });

  it('forbids fabricating knowledge source ids', () => {
    const prompt = buildResponseSystemPrompt('real_estate');
    expect(prompt).toContain('捏造しない');
    expect(prompt).toContain('knowledgeSourceIds');
  });

  it('degrades safely for an unknown product without throwing', () => {
    // Empty guardrail block, but the prompt still builds and asks for JSON.
    const prompt = buildResponseSystemPrompt('unknown_product');
    expect(prompt).toContain('JSON');
  });
});

describe('MEETING_MINUTES_SYSTEM_PROMPT', () => {
  it('bans fabricating decisions and routes intent to pending', () => {
    expect(MEETING_MINUTES_SYSTEM_PROMPT).toContain('創作');
    expect(MEETING_MINUTES_SYSTEM_PROMPT).toContain('pending');
    // Anti-invention example for agreed vs intent.
    expect(MEETING_MINUTES_SYSTEM_PROMPT).toContain('導入したい');
  });
});
