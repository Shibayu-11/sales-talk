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
} as const;

export const SUPABASE_REGION = 'ap-northeast-1';

export const SETTINGS_SCHEMA_VERSION = 1;

export const DEFAULT_HOTKEYS = {
  toggleOverlay: 'Option+Space',
  expandLayer3: 'Command+D',
  nextCandidate: 'Command+N',
  markUnused: 'Command+Shift+X',
} as const;
