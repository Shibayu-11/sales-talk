import { createActor } from 'xstate';
import { describe, expect, it } from 'vitest';
import type { DetectedObjection, ObjectionResponse, Transcript } from '../../src/shared/types';
import {
  objectionPipelineMachine,
  topicChanged,
} from '../../src/main/machines/objection-pipeline.machine';

const detected: DetectedObjection = {
  id: '00000000-0000-4000-8000-000000000001',
  type: 'price',
  confidence: 0.82,
  triggerText: '価格が高いですね',
  detectedAt: 1_777_000_000,
};

const response: ObjectionResponse = {
  id: '00000000-0000-4000-8000-000000000002',
  objectionId: detected.id,
  peak: '比較で整理',
  summary: ['総額で比較', '条件を揃える', '次に確認'],
  fullScript: '一般論として、条件を揃えて比較しましょう。',
  reasoning: '価格反論',
  notes: [],
  riskFlags: [],
  generatedAtMs: 1_777_000_001,
};

function interim(text: string, speaker: 'self' | 'counterpart' = 'counterpart'): Transcript {
  return {
    speaker,
    text,
    isFinal: false,
    startMs: 0,
  };
}

describe('objectionPipelineMachine', () => {
  it('moves from listening to ready for high-confidence objection and generated response', () => {
    const actor = createActor(objectionPipelineMachine);
    actor.start();

    actor.send({ type: 'INTERIM_TRANSCRIPT', transcript: interim('価格が高いですね') });
    expect(actor.getSnapshot().value).toBe('detecting');

    actor.send({ type: 'HAIKU_DETECTED', objection: detected });
    expect(actor.getSnapshot().value).toBe('speculating');

    actor.send({ type: 'SONNET_GENERATED', response });
    expect(actor.getSnapshot().value).toBe('ready');
    expect(actor.getSnapshot().context.detectedObjection?.id).toBe(detected.id);
    expect(actor.getSnapshot().context.speculativeResponse?.id).toBe(response.id);
  });

  it('ignores short or self transcripts while listening', () => {
    const actor = createActor(objectionPipelineMachine);
    actor.start();

    actor.send({ type: 'INTERIM_TRANSCRIPT', transcript: interim('高い') });
    expect(actor.getSnapshot().value).toBe('listening');

    actor.send({ type: 'INTERIM_TRANSCRIPT', transcript: interim('価格が高いですね', 'self') });
    expect(actor.getSnapshot().value).toBe('listening');
  });

  it('cancels speculation when topic changes', () => {
    const actor = createActor(objectionPipelineMachine);
    actor.start();

    actor.send({ type: 'INTERIM_TRANSCRIPT', transcript: interim('価格が高いですね') });
    actor.send({ type: 'HAIKU_DETECTED', objection: detected });
    actor.send({ type: 'INTERIM_TRANSCRIPT', transcript: interim('次回の日程調整をしましょう') });

    expect(actor.getSnapshot().value).toBe('listening');
    expect(actor.getSnapshot().context.detectedObjection).toBeNull();
  });
});

describe('topicChanged', () => {
  it('keeps related Japanese text on same topic', () => {
    expect(topicChanged('価格が高いですね', '価格面が高いと感じています')).toBe(false);
  });

  it('detects unrelated Japanese text', () => {
    expect(topicChanged('価格が高いですね', '次回の日程を調整しましょう')).toBe(true);
  });
});
