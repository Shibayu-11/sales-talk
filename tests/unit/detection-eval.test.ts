import { describe, expect, it } from 'vitest';
import { DETECTION_CORPUS } from '../../src/eval/detection/corpus';
import { keywordDetector } from '../../src/eval/detection/keyword-detector';
import {
  detectorFires,
  formatReport,
  scoreDetector,
  type Detector,
} from '../../src/eval/detection/score';

describe('detection eval harness', () => {
  it('scores the reference detector above the regression floor', () => {
    const report = scoreDetector(DETECTION_CORPUS, keywordDetector);
    // Log the metrics so CI shows movement over time.
    // eslint-disable-next-line no-console
    console.info('[detection-eval]', formatReport(report));

    // The whole point of the harness: no false positives on the distractor traps.
    expect(report.falsePositive).toBe(0);
    // The deterministic baseline should catch most clear objections.
    expect(report.recall).toBeGreaterThanOrEqual(0.8);
    expect(report.precision).toBe(1);
    // When it fires, the type should usually be right.
    expect(report.typeAccuracy).toBeGreaterThanOrEqual(0.9);
  });

  it('never fires on any "none"-labeled distractor (誤発火ゼロ)', () => {
    const report = scoreDetector(DETECTION_CORPUS, keywordDetector);
    const firedDistractors = report.items.filter(
      (i) => i.item.expected === 'none' && i.fired,
    );
    expect(firedDistractors.map((i) => i.item.utterance)).toEqual([]);
  });

  it('applies the live gates: short utterances and low confidence do not fire', () => {
    // High confidence but too short → suppressed by the length gate.
    expect(detectorFires({ isObjection: true, type: 'price', confidence: 0.99 }, '高い')).toBe(false);
    // Long enough but below the confidence threshold → suppressed.
    expect(
      detectorFires({ isObjection: true, type: 'price', confidence: 0.5 }, '価格が高いと思います'),
    ).toBe(false);
    // Long enough and confident → fires.
    expect(
      detectorFires({ isObjection: true, type: 'price', confidence: 0.9 }, '価格が高いと思います'),
    ).toBe(true);
  });

  it('counts a missed objection as a false negative, not a false positive', () => {
    const blindDetector: Detector = () => ({ isObjection: false, type: 'none', confidence: 0 });
    const report = scoreDetector(
      [{ utterance: '費用が高くて判断が難しいです。', expected: 'price' }],
      blindDetector,
    );
    expect(report.falseNegative).toBe(1);
    expect(report.falsePositive).toBe(0);
    expect(report.recall).toBe(0);
  });

  it('flags an over-eager detector as low precision', () => {
    const triggerHappy: Detector = () => ({ isObjection: true, type: 'price', confidence: 0.95 });
    const report = scoreDetector(DETECTION_CORPUS, triggerHappy);
    // Fires on every distractor → many false positives.
    expect(report.falsePositive).toBeGreaterThan(0);
    expect(report.precision).toBeLessThan(1);
  });
});
