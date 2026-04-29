import { assign, setup } from 'xstate';
import { HAIKU_CONFIDENCE_THRESHOLD, SHORT_UTTERANCE_FILTER_CHARS } from '@shared/constants';
import type { DetectedObjection, ObjectionResponse, Transcript } from '@shared/types';

export interface ObjectionPipelineContext {
  currentTranscript: string;
  detectedObjection: DetectedObjection | null;
  speculativeResponse: ObjectionResponse | null;
  speculationStartedAt: number | null;
  lastReadyAt: number | null;
}

export type ObjectionPipelineEvent =
  | { type: 'INTERIM_TRANSCRIPT'; transcript: Transcript }
  | { type: 'FINAL_TRANSCRIPT'; transcript: Transcript }
  | { type: 'SPEECH_START'; speaker: 'self' | 'counterpart' }
  | { type: 'SPEECH_END'; speaker: 'self' | 'counterpart' }
  | { type: 'HAIKU_DETECTED'; objection: DetectedObjection }
  | { type: 'HAIKU_DISMISSED' }
  | { type: 'SONNET_GENERATED'; response: ObjectionResponse }
  | { type: 'SONNET_FAILED'; errorMessage: string }
  | { type: 'OVERLAY_DISPLAYED' }
  | { type: 'USER_SPEAKING_START' }
  | { type: 'USER_DISMISSED' };

export const initialObjectionPipelineContext: ObjectionPipelineContext = {
  currentTranscript: '',
  detectedObjection: null,
  speculativeResponse: null,
  speculationStartedAt: null,
  lastReadyAt: null,
};

export const objectionPipelineMachine = setup({
  types: {} as {
    context: ObjectionPipelineContext;
    events: ObjectionPipelineEvent;
  },
  guards: {
    isCounterpartTranscript: ({ event }) => isCounterpartInterimTranscript(event),
    isLongEnough: ({ event }) => isLongEnoughInterimTranscript(event),
    isHighConfidence: ({ event }) =>
      event.type === 'HAIKU_DETECTED' &&
      event.objection.confidence >= HAIKU_CONFIDENCE_THRESHOLD,
    isCounterpartSpeechEnd: ({ event }) =>
      event.type === 'SPEECH_END' && event.speaker === 'counterpart',
    topicChanged: ({ context, event }) =>
      event.type === 'INTERIM_TRANSCRIPT' && topicChanged(context.currentTranscript, event.transcript.text),
  },
  actions: {
    updateTranscript: assign({
      currentTranscript: ({ event }) =>
        event.type === 'INTERIM_TRANSCRIPT' || event.type === 'FINAL_TRANSCRIPT'
          ? event.transcript.text
          : '',
    }),
    setDetectedObjection: assign({
      detectedObjection: ({ event }) => (event.type === 'HAIKU_DETECTED' ? event.objection : null),
      speculationStartedAt: ({ event }) => (event.type === 'HAIKU_DETECTED' ? Date.now() : null),
    }),
    setSpeculativeResponse: assign({
      speculativeResponse: ({ event }) => (event.type === 'SONNET_GENERATED' ? event.response : null),
      lastReadyAt: ({ event }) => (event.type === 'SONNET_GENERATED' ? Date.now() : null),
    }),
    clearSpeculation: assign({
      detectedObjection: null,
      speculativeResponse: null,
      speculationStartedAt: null,
      lastReadyAt: null,
    }),
    resetAll: assign(() => initialObjectionPipelineContext),
  },
}).createMachine({
  id: 'objectionPipeline',
  initial: 'listening',
  context: initialObjectionPipelineContext,
  states: {
    listening: {
      entry: 'clearSpeculation',
      on: {
        INTERIM_TRANSCRIPT: {
          target: 'detecting',
          guard: ({ event }) => isCounterpartInterimTranscript(event) && isLongEnoughInterimTranscript(event),
          actions: 'updateTranscript',
        },
      },
    },
    detecting: {
      on: {
        INTERIM_TRANSCRIPT: {
          actions: 'updateTranscript',
          guard: 'isCounterpartTranscript',
        },
        HAIKU_DETECTED: [
          {
            target: 'speculating',
            guard: 'isHighConfidence',
            actions: 'setDetectedObjection',
          },
          { target: 'listening' },
        ],
        HAIKU_DISMISSED: {
          target: 'listening',
        },
        SPEECH_END: {
          target: 'listening',
          guard: 'isCounterpartSpeechEnd',
        },
        USER_DISMISSED: {
          target: 'listening',
        },
      },
    },
    speculating: {
      on: {
        INTERIM_TRANSCRIPT: [
          {
            target: 'listening',
            guard: 'topicChanged',
            actions: 'clearSpeculation',
          },
          {
            actions: 'updateTranscript',
            guard: 'isCounterpartTranscript',
          },
        ],
        SONNET_GENERATED: {
          target: 'ready',
          actions: 'setSpeculativeResponse',
        },
        SONNET_FAILED: {
          target: 'listening',
        },
        HAIKU_DISMISSED: {
          target: 'listening',
        },
        USER_DISMISSED: {
          target: 'listening',
        },
      },
    },
    ready: {
      on: {
        OVERLAY_DISPLAYED: {
          target: 'displayed',
        },
        USER_SPEAKING_START: {
          target: 'listening',
        },
        USER_DISMISSED: {
          target: 'listening',
        },
      },
      after: {
        5_000: {
          target: 'listening',
        },
      },
    },
    displayed: {
      on: {
        USER_SPEAKING_START: {
          target: 'consumed',
        },
        USER_DISMISSED: {
          target: 'listening',
        },
      },
      after: {
        3_000: {
          target: 'consumed',
        },
      },
    },
    consumed: {
      always: {
        target: 'listening',
        actions: 'resetAll',
      },
    },
  },
});

export function topicChanged(oldText: string, newText: string): boolean {
  const oldTokens = tokenizeJapaneseLikeText(oldText);
  const newTokens = tokenizeJapaneseLikeText(newText);
  if (oldTokens.size === 0 || newTokens.size === 0) return false;

  const intersection = [...oldTokens].filter((token) => newTokens.has(token)).length;
  const union = new Set([...oldTokens, ...newTokens]).size;
  return intersection / union < 0.3;
}

function isCounterpartInterimTranscript(event: ObjectionPipelineEvent): boolean {
  return event.type === 'INTERIM_TRANSCRIPT' && event.transcript.speaker === 'counterpart';
}

function isLongEnoughInterimTranscript(event: ObjectionPipelineEvent): boolean {
  return (
    event.type === 'INTERIM_TRANSCRIPT' &&
    event.transcript.text.trim().length > SHORT_UTTERANCE_FILTER_CHARS
  );
}

function tokenizeJapaneseLikeText(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .replace(/[、。,.!?！？()[\]「」『』]/g, ' ')
    .trim();
  if (!normalized) return new Set();

  const terms = normalized.split(/\s+/).filter((term) => term.length > 0);
  if (terms.length > 1) return new Set(terms);

  const compact = normalized.replace(/\s/g, '');
  const tokens: string[] = [];
  for (const char of compact) {
    tokens.push(char);
  }
  for (let index = 0; index < compact.length - 1; index += 1) {
    tokens.push(compact.slice(index, index + 2));
  }
  return new Set(tokens.length > 0 ? tokens : [compact]);
}
