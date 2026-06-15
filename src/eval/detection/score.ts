import { HAIKU_CONFIDENCE_THRESHOLD, SHORT_UTTERANCE_FILTER_CHARS } from '@shared/constants';

/**
 * Detection eval harness. Scores ANY detector (the deterministic reference, or
 * the real Haiku detector once an API key is available) against a labeled corpus,
 * applying the SAME gates the live pipeline applies (short-utterance filter +
 * confidence threshold). Pure so it runs with no LLM and no network.
 *
 * Primary metric for this product: false-positive rate (誤発火) — a wrong overlay
 * mid-call is worse than a missed one.
 */

/** 'none' means the utterance is NOT an objection (相槌・確認・雑談). */
export type ExpectedLabel = string | 'none';

export interface CorpusItem {
  utterance: string;
  /** Expected objection type, or 'none' for a distractor. */
  expected: ExpectedLabel;
  /** Optional note on why this case matters (e.g. known false-positive trap). */
  note?: string;
}

export interface DetectorOutput {
  isObjection: boolean;
  type: string;
  confidence: number;
}

export type Detector = (utterance: string) => DetectorOutput;

export interface ScoredItem {
  item: CorpusItem;
  output: DetectorOutput;
  /** After applying length + confidence gates: did we fire an overlay? */
  fired: boolean;
  outcome: 'true_positive' | 'false_positive' | 'true_negative' | 'false_negative';
  /** For fired objections, whether the type matched the expected label. */
  typeCorrect: boolean | null;
}

export interface EvalReport {
  total: number;
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
  precision: number;
  recall: number;
  f1: number;
  /** correct-type / fired-true-positive */
  typeAccuracy: number;
  /** false_positive items — the most important to eyeball. */
  falsePositives: ScoredItem[];
  falseNegatives: ScoredItem[];
  items: ScoredItem[];
}

export interface ScoreOptions {
  confidenceThreshold?: number;
  minChars?: number;
}

/**
 * A detector "fires" only if it claims an objection AND clears the live gates
 * (utterance long enough, confidence at/above threshold) — same as the pipeline.
 */
export function detectorFires(output: DetectorOutput, utterance: string, opts?: ScoreOptions): boolean {
  const minChars = opts?.minChars ?? SHORT_UTTERANCE_FILTER_CHARS;
  const threshold = opts?.confidenceThreshold ?? HAIKU_CONFIDENCE_THRESHOLD;
  return (
    output.isObjection &&
    utterance.trim().length > minChars &&
    output.confidence >= threshold
  );
}

export function scoreDetector(
  corpus: CorpusItem[],
  detector: Detector,
  opts?: ScoreOptions,
): EvalReport {
  const items: ScoredItem[] = corpus.map((item) => {
    const output = detector(item.utterance);
    const fired = detectorFires(output, item.utterance, opts);
    const isObjectionExpected = item.expected !== 'none';

    let outcome: ScoredItem['outcome'];
    if (fired && isObjectionExpected) outcome = 'true_positive';
    else if (fired && !isObjectionExpected) outcome = 'false_positive';
    else if (!fired && !isObjectionExpected) outcome = 'true_negative';
    else outcome = 'false_negative';

    const typeCorrect =
      outcome === 'true_positive' ? output.type === item.expected : null;

    return { item, output, fired, outcome, typeCorrect };
  });

  const count = (o: ScoredItem['outcome']): number =>
    items.filter((i) => i.outcome === o).length;
  const truePositive = count('true_positive');
  const falsePositive = count('false_positive');
  const trueNegative = count('true_negative');
  const falseNegative = count('false_negative');

  const precision = safeRatio(truePositive, truePositive + falsePositive);
  const recall = safeRatio(truePositive, truePositive + falseNegative);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const typeCorrectCount = items.filter((i) => i.typeCorrect === true).length;
  const typeAccuracy = safeRatio(typeCorrectCount, truePositive);

  return {
    total: corpus.length,
    truePositive,
    falsePositive,
    trueNegative,
    falseNegative,
    precision,
    recall,
    f1,
    typeAccuracy,
    falsePositives: items.filter((i) => i.outcome === 'false_positive'),
    falseNegatives: items.filter((i) => i.outcome === 'false_negative'),
    items,
  };
}

function safeRatio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

/** One-line human summary for logs / CI output. */
export function formatReport(report: EvalReport): string {
  return [
    `n=${report.total}`,
    `precision=${pct(report.precision)}`,
    `recall=${pct(report.recall)}`,
    `f1=${pct(report.f1)}`,
    `typeAcc=${pct(report.typeAccuracy)}`,
    `FP=${report.falsePositive}`,
    `FN=${report.falseNegative}`,
  ].join(' ');
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}
