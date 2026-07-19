import { createHash } from 'node:crypto';

import type { MeetingMinute, MeetingSource, ProductId } from '@shared/types';

import { maskPiiInText } from './pii';

export const COMPANY_KNOWLEDGE_CANDIDATE_LIMIT = 25;

export type CompanyKnowledgeCandidateKind =
  | 'summary'
  | 'agreed'
  | 'decision'
  | 'pending'
  | 'number';

export interface CompanyKnowledgeCandidateSource {
  callId: string;
  minuteId: string;
  transcriptRevisionId: string | null;
  productId: ProductId;
  meetingSource: MeetingSource;
  minuteGeneratedAt: string;
  field: CompanyKnowledgeCandidateKind;
  itemIndex: number | null;
}

export interface CompanyKnowledgeCandidate {
  tenantId: string;
  organizationId: string;
  kind: CompanyKnowledgeCandidateKind;
  text: string;
  normalizedText: string;
  fingerprint: string;
  source: CompanyKnowledgeCandidateSource;
}

export interface ExtractCompanyKnowledgeCandidatesInput {
  tenantId: string;
  organizationId: string;
  minute: MeetingMinute;
}

const PLACEHOLDER_TEXTS = new Set([
  '-',
  '—',
  '―',
  '–',
  'n/a',
  'na',
  'none',
  'null',
  'undefined',
  'tbd',
  'todo',
  'placeholder',
  'なし',
  '無し',
  '特になし',
  '未定',
  '不明',
  '該当なし',
]);

export function extractCompanyKnowledgeCandidates(
  input: ExtractCompanyKnowledgeCandidatesInput,
): CompanyKnowledgeCandidate[] {
  const candidates: CompanyKnowledgeCandidate[] = [];
  const seenFingerprints = new Set<string>();

  for (const draft of createCandidateDrafts(input.minute)) {
    if (candidates.length >= COMPANY_KNOWLEDGE_CANDIDATE_LIMIT) break;

    const normalizedText = sanitizeKnowledgeText(draft.text);
    if (!normalizedText) continue;

    const fingerprint = createCandidateFingerprint({
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      normalizedText,
    });
    if (seenFingerprints.has(fingerprint)) continue;

    seenFingerprints.add(fingerprint);
    candidates.push({
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      kind: draft.kind,
      text: normalizedText,
      normalizedText,
      fingerprint,
      source: {
        callId: input.minute.callId,
        minuteId: input.minute.id,
        transcriptRevisionId: input.minute.transcriptRevisionId,
        productId: input.minute.productId,
        meetingSource: input.minute.source,
        minuteGeneratedAt: input.minute.generatedAt,
        field: draft.kind,
        itemIndex: draft.itemIndex,
      },
    });
  }

  return candidates;
}

interface CandidateDraft {
  kind: CompanyKnowledgeCandidateKind;
  text: string;
  itemIndex: number | null;
}

function createCandidateDrafts(minute: MeetingMinute): CandidateDraft[] {
  return [
    { kind: 'summary', text: minute.summary, itemIndex: null },
    ...minute.agreed.map((text, itemIndex) => ({ kind: 'agreed' as const, text, itemIndex })),
    ...minute.decisions.map((text, itemIndex) => ({
      kind: 'decision' as const,
      text,
      itemIndex,
    })),
    ...minute.pending.map((text, itemIndex) => ({ kind: 'pending' as const, text, itemIndex })),
    ...minute.numbers.map((number, itemIndex) => ({
      kind: 'number' as const,
      text: formatNumberKnowledgeText(number),
      itemIndex,
    })),
  ];
}

function formatNumberKnowledgeText(number: MeetingMinute['numbers'][number]): string {
  const label = sanitizeKnowledgeText(number.label);
  const value = sanitizeKnowledgeText(number.value);

  if (!value) return '';
  return label ? `${label}: ${value}` : value;
}

function sanitizeKnowledgeText(value: string): string | null {
  const normalizedText = normalizeKnowledgeText(maskPiiInText(value));
  if (!normalizedText || isPlaceholderText(normalizedText)) return null;
  return normalizedText;
}

function normalizeKnowledgeText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function isPlaceholderText(value: string): boolean {
  const normalizedValue = value
    .toLocaleLowerCase('ja-JP')
    .replace(/[。.!！?？]+$/g, '')
    .trim();

  return PLACEHOLDER_TEXTS.has(normalizedValue);
}

function createCandidateFingerprint(input: {
  tenantId: string;
  organizationId: string;
  normalizedText: string;
}): string {
  return createHash('sha256')
    .update([input.tenantId, input.organizationId, input.normalizedText].join('\0'))
    .digest('hex');
}
