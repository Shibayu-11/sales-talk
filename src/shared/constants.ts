/**
 * Application-wide constants.
 */

/** Per PRD §15.9 */
export const AUDIO_SAMPLE_RATE = 16_000;
export const AUDIO_CHANNELS = 1;
export const AUDIO_CHUNK_MS = 100;

/** Per PRD §12.5 */
export const HAIKU_CONFIDENCE_THRESHOLD = 0.7;
export const SHORT_UTTERANCE_FILTER_CHARS = 5;

/** Per PRD §15.7 */
export const STT_MAX_RECONNECT = 10;
export const STT_BUFFER_MAX_MS = 30_000;
export const STT_KEEPALIVE_MS = 5_000;

/** Per PRD §15.5 */
export const DEEPGRAM_ENDPOINTING_MS = 500;
export const DEEPGRAM_UTTERANCE_END_MS = 2_000;

/** Per PRD §17.3 */
export const COHERE_EMBED_MODEL = 'embed-v4.0';
export const COHERE_EMBED_DIMENSIONS = 1_024;
export const COHERE_MAX_TEXTS_PER_REQUEST = 96;

/** Per PRD §22.4 */
export const MEETING_AUTO_DELETE_DAYS = 30;

/** Per PRD §6.5: PII masking patterns */
export const PII_PATTERNS = {
  phoneJp: /(\+81|0)\d{1,4}-?\d{1,4}-?\d{4}/g,
  email: /[\w._%+-]+@[\w.-]+\.[A-Za-z]{2,}/g,
  creditCard: /\b(?:\d[ -]*?){13,16}\b/g,
  postalCodeJp: /〒?\d{3}-?\d{4}/g,
  japaneseNameWithHonorific: /[一-龥々]{2,6}(?:さん|様|氏)/g,
  japaneseAddress:
    /(?:東京都|北海道|(?:京都|大阪)府|[一-龥]{2,3}県)[^\s、。]{2,30}(?:市|区|町|村|郡|丁目|番地|号)[^\s、。]{0,20}/g,
} as const;

export const SUPABASE_REGION = 'ap-northeast-1';

export const SETTINGS_SCHEMA_VERSION = 1;

/** Per PRD §32: never auto-update during a call; re-check this often while an update waits. */
export const UPDATE_DEFERRED_RETRY_MS = 15 * 60 * 1_000;

export const DEFAULT_HOTKEYS = {
  toggleOverlay: 'Option+Space',
  expandLayer3: 'Command+D',
  nextCandidate: 'Command+N',
  markUnused: 'Command+Shift+X',
} as const;
