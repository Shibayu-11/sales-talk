import type { CorpusItem } from './score';

/**
 * Labeled detection corpus for regression-testing detection precision without an
 * LLM. Mirrors the few-shot examples baked into HAIKU_DETECTION_SYSTEM_PROMPT and
 * adds the false-positive traps that matter most in real B2B calls.
 *
 * Expand this over time with real (PII-masked) utterances from live calls — the
 * harness (score.ts) scores any detector against it, including the real Haiku
 * detector once an API key is available.
 */
export const DETECTION_CORPUS: CorpusItem[] = [
  // --- price ---
  { utterance: '費用が高くて、今すぐの判断は難しいですね。', expected: 'price' },
  { utterance: '正直、価格がちょっと予算オーバーなんですよね。', expected: 'price' },
  { utterance: 'もう少し安くなりませんか。', expected: 'price' },

  // --- timing ---
  { utterance: '今すぐではなくて、来期から検討でもいいですか。', expected: 'timing' },
  { utterance: '導入の時期は正直もう少し先かなと思っています。', expected: 'timing' },

  // --- authority ---
  { utterance: '私の一存では決められないので、上長に確認しないと。', expected: 'authority' },
  { utterance: '社内で決裁を通す必要があって、持ち帰らせてください。', expected: 'authority' },

  // --- status_quo ---
  { utterance: '今のやり方で特に困ってないんですよね。', expected: 'status_quo' },
  { utterance: '現状維持でも問題ないと感じています。', expected: 'status_quo' },

  // --- trust ---
  { utterance: '本当に効果が出るのか、正直疑問です。', expected: 'trust' },
  { utterance: '導入実績や事例はどのくらいあるんですか、不安で。', expected: 'trust' },

  // --- competitor ---
  { utterance: '他社さんからも似た提案を受けていまして。', expected: 'competitor' },
  { utterance: '比較検討中で、A社の方が安かったんですよね。', expected: 'competitor' },

  // --- distractors: 相槌 / 確認 / 雑談 (must NOT fire) ---
  { utterance: 'はい、なるほど。', expected: 'none', note: '相槌・短文' },
  { utterance: 'そうですね、わかりました。', expected: 'none', note: '同意' },
  { utterance: '予算を確認しておきます。', expected: 'none', note: '価格語を含むが反論ではない(誤発火トラップ)' },
  { utterance: '画面は見えていますか?', expected: 'none', note: 'Zoom操作確認' },
  { utterance: '今日は天気がいいですね。', expected: 'none', note: '時間語「今」を含む雑談トラップ' },
  { utterance: '資料を後で送っていただけますか。', expected: 'none', note: '依頼' },
  { utterance: '御社のオフィスは渋谷でしたっけ。', expected: 'none', note: '情報確認' },
  { utterance: 'もう一度説明していただけますか。', expected: 'none', note: '質問' },
  { utterance: 'ありがとうございます、助かります。', expected: 'none', note: '謝意' },
];
