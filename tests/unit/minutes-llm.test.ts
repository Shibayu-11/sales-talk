import { describe, expect, it, vi } from 'vitest';
import type { Transcript } from '../../src/shared/types';
import {
  buildMinutesTranscriptLines,
  DevelopmentMockMinutesProvider,
  MinutesLlmService,
  type MinutesLlmProvider,
} from '../../src/main/services/minutes-llm';

function finalTranscript(text: string, startMs: number, speaker: 'self' | 'counterpart' = 'counterpart'): Transcript {
  return { speaker, text, isFinal: true, startMs, endMs: startMs + 1_000 };
}

describe('buildMinutesTranscriptLines', () => {
  it('formats final transcripts with mm:ss prefix, speaker label, and PII masking', () => {
    const lines = buildMinutesTranscriptLines([
      finalTranscript('連絡先は customer@example.com です', 65_000),
      finalTranscript('承知しました', 70_000, 'self'),
      { speaker: 'counterpart', text: '途中経過', isFinal: false, startMs: 80_000 },
      finalTranscript('   ', 90_000),
    ]);

    expect(lines).toEqual([
      '[01:05] 相手: 連絡先は [redacted-email] です',
      '[01:10] 自分: 承知しました',
    ]);
  });
});

describe('MinutesLlmService', () => {
  it('returns null without calling the provider when there are no final transcripts', async () => {
    const provider: MinutesLlmProvider = { generateMeetingMinutes: vi.fn() };
    const service = new MinutesLlmService(provider);

    const result = await service.generate({ productId: 'real_estate', transcripts: [] });

    expect(result).toBeNull();
    expect(provider.generateMeetingMinutes).not.toHaveBeenCalled();
  });

  it('validates provider output against the schema', async () => {
    const provider: MinutesLlmProvider = {
      generateMeetingMinutes: vi.fn(async () => ({
        summary: '価格と導入時期を中心に議論。',
        agreed: ['[00:30] 次回までに見積を共有する'],
        pending: [],
        decisions: ['[01:05] 7月導入を前提に進める'],
      })),
    };
    const service = new MinutesLlmService(provider);

    const result = await service.generate({
      productId: 'real_estate',
      transcripts: [finalTranscript('価格が高いですね', 30_000)],
    });

    expect(result).toEqual(
      expect.objectContaining({
        summary: '価格と導入時期を中心に議論。',
        decisions: ['[01:05] 7月導入を前提に進める'],
      }),
    );
  });

  it('rejects malformed provider output', async () => {
    const provider: MinutesLlmProvider = {
      generateMeetingMinutes: vi.fn(async () => ({ summary: '', agreed: 'not-array' })),
    };
    const service = new MinutesLlmService(provider);

    await expect(
      service.generate({
        productId: 'real_estate',
        transcripts: [finalTranscript('価格が高いですね', 0)],
      }),
    ).rejects.toThrow();
  });
});

describe('DevelopmentMockMinutesProvider', () => {
  it('produces schema-valid output for keyless development', async () => {
    const service = new MinutesLlmService(new DevelopmentMockMinutesProvider());
    const result = await service.generate({
      productId: 'hojokin',
      transcripts: [finalTranscript('補助金の採択率が気になります', 12_000)],
    });

    expect(result?.summary).toContain('mock');
    expect(result?.decisions.length).toBeGreaterThan(0);
  });
});
