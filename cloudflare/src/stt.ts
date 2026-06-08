import { z } from 'zod';

export interface SttQueueMessage {
  jobId: string;
  callId: string;
  audioAssetId: string;
  r2Key: string;
  tenantId: string;
  organizationId: string;
  mimeType: string;
}

export interface TranscriptSegmentInput {
  id: string;
  callId: string;
  tenantId: string;
  organizationId: string;
  speaker: 'counterpart';
  text: string;
  isFinal: boolean;
  startMs: number;
  endMs: number | null;
  createdAt: string;
}

const DeepgramPrerecordedResponseSchema = z.object({
  results: z.object({
    channels: z
      .array(
        z.object({
          alternatives: z
            .array(
              z.object({
                paragraphs: z
                  .object({
                    transcript: z.string().default(''),
                  })
                  .optional(),
                transcript: z.string().default(''),
                words: z
                  .array(
                    z.object({
                      word: z.string().default(''),
                      start: z.number().default(0),
                      end: z.number().default(0),
                    }),
                  )
                  .default([]),
              }),
            )
            .min(1),
        }),
      )
      .min(1),
  }),
});

export async function transcribeWithDeepgram(input: {
  apiKey: string;
  audio: ArrayBuffer;
  mimeType: string;
  fetch?: typeof fetch | undefined;
}): Promise<Array<{ text: string; startMs: number; endMs: number | null }>> {
  const request = input.fetch ?? fetch;
  const response = await request(buildDeepgramPrerecordedUrl(), {
    method: 'POST',
    headers: {
      authorization: `Token ${input.apiKey}`,
      'content-type': input.mimeType,
    },
    body: input.audio,
  });
  if (!response.ok) {
    throw new Error(`deepgram_prerecorded_failed_${response.status}`);
  }
  return parseDeepgramPrerecorded(await response.json());
}

export function parseDeepgramPrerecorded(value: unknown): Array<{
  text: string;
  startMs: number;
  endMs: number | null;
}> {
  const parsed = DeepgramPrerecordedResponseSchema.parse(value);
  const alternative = parsed.results.channels[0]!.alternatives[0]!;
  const paragraphText = alternative.paragraphs?.transcript.trim();
  const transcript = (paragraphText || alternative.transcript).trim();
  if (!transcript) {
    return [];
  }
  const firstWord = alternative.words[0];
  const lastWord = alternative.words.at(-1);
  return [
    {
      text: transcript,
      startMs: Math.round((firstWord?.start ?? 0) * 1_000),
      endMs: lastWord ? Math.round(lastWord.end * 1_000) : null,
    },
  ];
}

function buildDeepgramPrerecordedUrl(): string {
  const url = new URL('https://api.deepgram.com/v1/listen');
  url.searchParams.set('model', 'nova-3');
  url.searchParams.set('language', 'ja');
  url.searchParams.set('smart_format', 'true');
  url.searchParams.set('punctuate', 'true');
  url.searchParams.set('paragraphs', 'true');
  return url.toString();
}
