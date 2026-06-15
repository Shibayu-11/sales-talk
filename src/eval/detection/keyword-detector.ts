import type { Detector, DetectorOutput } from './score';

/**
 * Deterministic reference detector — NO LLM. Encodes the detection intent from
 * HAIKU_DETECTION_SYSTEM_PROMPT as keyword/pattern rules so the corpus has a
 * regression baseline that runs offline.
 *
 * This is intentionally conservative: it suppresses the known false-positive
 * traps (確認/質問/雑談 that merely contain a price/timing word) before matching
 * objection patterns. It is NOT meant to match the LLM's quality — it's a floor
 * the deterministic guards must hold.
 */

interface TypeRule {
  type: string;
  patterns: RegExp[];
  confidence: number;
}

// Non-objection cues. If an utterance is dominated by these, never fire.
const SUPPRESS_PATTERNS: RegExp[] = [
  /確認しておきます|確認します/, // 「予算を確認しておきます」
  /見えていますか|聞こえていますか|画面は/, // Zoom操作確認
  /送っていただけますか|送ってください|いただけますか/, // 依頼
  /でしたっけ|ですか\?|ですか?$/, // 情報確認・質問
  /ありがとう|助かります/, // 謝意
  /天気|お元気/, // 雑談
];

const RULES: TypeRule[] = [
  {
    type: 'price',
    patterns: [/高くて|高いです|高いん|予算オーバー|予算を超|安くなりません|安くして/],
    confidence: 0.9,
  },
  {
    type: 'timing',
    patterns: [/来期|時期は.*先|もう少し先|今すぐではなく|タイミングが/],
    confidence: 0.85,
  },
  {
    type: 'authority',
    patterns: [/一存では|決められない|決裁|持ち帰|上長に確認|社内で/],
    confidence: 0.88,
  },
  {
    type: 'status_quo',
    patterns: [/困ってない|困っていない|現状維持|今のやり方で/],
    confidence: 0.85,
  },
  {
    type: 'trust',
    patterns: [/本当に効果|効果が出るのか|疑問|不安/],
    confidence: 0.82,
  },
  {
    type: 'competitor',
    patterns: [/他社|比較検討|A社|B社|の方が安/],
    confidence: 0.82,
  },
];

const NONE: DetectorOutput = { isObjection: false, type: 'none', confidence: 0.1 };

export const keywordDetector: Detector = (utterance: string): DetectorOutput => {
  const text = utterance.trim();

  // Suppress known non-objection cues first (avoids price/timing-word traps).
  if (SUPPRESS_PATTERNS.some((p) => p.test(text))) {
    return NONE;
  }

  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(text))) {
      return { isObjection: true, type: rule.type, confidence: rule.confidence };
    }
  }

  return NONE;
};
