import { app } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  KnowledgeCandidateSchema,
  KnowledgeEntrySchema,
  type KnowledgeCreateInput,
} from '@shared/schemas';
import type {
  KnowledgeCandidate,
  KnowledgeCandidateKind,
  KnowledgeCandidateStatus,
  KnowledgeEntry,
  KnowledgeSourceType,
  ProductId,
} from '@shared/types';
import { writeFileAtomic } from './atomic-file';
import { maskPiiInText } from './pii';

const LocalKnowledgeDataSchema = z.object({
  entries: z.array(KnowledgeEntrySchema),
  candidates: z.array(KnowledgeCandidateSchema).default([]),
});

type LocalKnowledgeData = z.infer<typeof LocalKnowledgeDataSchema>;

export interface KnowledgeScope {
  tenantId: string;
  organizationId: string;
}

export interface KnowledgeEntryCreateMetadata {
  scope?: KnowledgeScope | undefined;
  sourceType?: KnowledgeSourceType | undefined;
  sourceCallId?: string | null | undefined;
  sourceMeetingMinuteId?: string | null | undefined;
  sourceTranscriptRevisionId?: string | null | undefined;
  status?: KnowledgeEntry['status'] | undefined;
  fingerprint?: string | null | undefined;
  approvedByUserId?: string | null | undefined;
  approvedAt?: string | null | undefined;
}

export interface KnowledgeCandidateDraft {
  tenantId: string;
  organizationId: string;
  productId: ProductId;
  kind: KnowledgeCandidateKind;
  title: string;
  content: string;
  reasoning: string;
  riskFlags: string[];
  validationFlags: string[];
  legalRisk: KnowledgeCandidate['legalRisk'];
  sourceCallId: string;
  sourceMeetingMinuteId: string;
  sourceTranscriptRevisionId: string | null;
  sourceSegmentIds: string[];
  sourceEvidenceHash: string;
  fingerprint: string;
}

export interface KnowledgeCandidateReview {
  id: string;
  decision: 'approve' | 'reject';
  reviewerUserId: string;
  title?: string | undefined;
  content?: string | undefined;
  objectionType?: string | undefined;
  reviewNote?: string | undefined;
}

function createDefaultKnowledgeData(): LocalKnowledgeData {
  return { entries: [], candidates: [] };
}

export class LocalKnowledgeStore {
  private cache: LocalKnowledgeData | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = join(defaultUserDataPath(), 'local-knowledge.json')) {}

  async list(productId: ProductId, scope?: KnowledgeScope): Promise<KnowledgeEntry[]> {
    if (scope) {
      await this.adoptLegacyEntries(scope);
    }
    const data = await this.get();
    return data.entries.filter(
      (entry) =>
        entry.productId === productId &&
        entry.status === 'approved' &&
        isEntryVisible(entry, scope),
    );
  }

  async search(
    query: string,
    productId: ProductId,
    limit: number,
    scope?: KnowledgeScope,
  ): Promise<KnowledgeEntry[]> {
    const normalizedQuery = normalizeText(query);
    const entries = await this.list(productId, scope);
    return entries
      .filter((entry) =>
        normalizeText(
          [entry.objectionType, entry.trigger, entry.response, entry.reasoning].join('\n'),
        ).includes(normalizedQuery),
      )
      .slice(0, limit);
  }

  async create(
    input: KnowledgeCreateInput,
    metadata: KnowledgeEntryCreateMetadata = {},
  ): Promise<KnowledgeEntry> {
    return this.mutate(async (data) => {
      const now = new Date().toISOString();
      const trigger = maskPiiInText(input.trigger).trim();
      const response = maskPiiInText(input.response).trim();
      const reasoning = maskPiiInText(input.reasoning ?? '').trim();
      const entry: KnowledgeEntry = {
        id: randomUUID(),
        tenantId: metadata.scope?.tenantId ?? null,
        organizationId: metadata.scope?.organizationId ?? null,
        productId: input.productId,
        objectionType: input.objectionType,
        trigger,
        response,
        reasoning,
        riskFlags: input.riskFlags ?? [],
        sourceType: metadata.sourceType ?? 'manual',
        sourceCallId: metadata.sourceCallId ?? null,
        sourceMeetingMinuteId: metadata.sourceMeetingMinuteId ?? null,
        sourceTranscriptRevisionId: metadata.sourceTranscriptRevisionId ?? null,
        status: metadata.status ?? 'approved',
        fingerprint:
          metadata.fingerprint ??
          createKnowledgeFingerprint({
            tenantId: metadata.scope?.tenantId ?? null,
            organizationId: metadata.scope?.organizationId ?? null,
            trigger,
            response,
          }),
        approvedByUserId: metadata.approvedByUserId ?? null,
        approvedAt: metadata.approvedAt ?? (metadata.status === 'needs_review' ? null : now),
        createdAt: now,
        updatedAt: now,
      };
      return {
        next: { ...data, entries: [entry, ...data.entries] },
        result: entry,
      };
    });
  }

  async delete(id: string, scope?: KnowledgeScope): Promise<void> {
    await this.mutate(async (data) => {
      const entry = data.entries.find((candidate) => candidate.id === id);
      if (!entry || !isEntryVisible(entry, scope)) {
        throw new Error('Knowledge entry was not found');
      }
      if (entry.sourceType === 'builtin') {
        throw new Error('Built-in knowledge cannot be deleted');
      }
      return {
        next: { ...data, entries: data.entries.filter((candidate) => candidate.id !== id) },
        result: undefined,
      };
    });
  }

  async saveCandidates(drafts: KnowledgeCandidateDraft[]): Promise<KnowledgeCandidate[]> {
    if (drafts.length === 0) {
      return [];
    }
    const first = drafts[0];
    if (!first) {
      return [];
    }
    assertCandidateBatch(drafts, first);

    return this.mutate(async (data) => {
      const now = new Date().toISOString();
      const supersededCandidates = data.candidates.map((candidate) =>
        candidate.tenantId === first.tenantId &&
        candidate.organizationId === first.organizationId &&
        candidate.sourceCallId === first.sourceCallId &&
        candidate.sourceMeetingMinuteId !== first.sourceMeetingMinuteId &&
        candidate.status === 'pending'
          ? { ...candidate, status: 'superseded' as const, updatedAt: now }
          : candidate,
      );
      const revalidationEntries = data.entries.map((entry) =>
        entry.tenantId === first.tenantId &&
        entry.organizationId === first.organizationId &&
        entry.sourceCallId === first.sourceCallId &&
        entry.sourceTranscriptRevisionId !== first.sourceTranscriptRevisionId &&
        entry.sourceType === 'meeting' &&
        entry.status === 'approved'
          ? { ...entry, status: 'needs_review' as const, updatedAt: now }
          : entry,
      );
      const created: KnowledgeCandidate[] = [];
      let candidates = supersededCandidates;

      for (const draft of drafts) {
        const existing = candidates.find(
          (candidate) =>
            candidate.sourceMeetingMinuteId === draft.sourceMeetingMinuteId &&
            candidate.fingerprint === draft.fingerprint,
        );
        if (existing) {
          created.push(existing);
          continue;
        }
        const duplicateEntry = revalidationEntries.find(
          (entry) =>
            entry.tenantId === draft.tenantId &&
            entry.organizationId === draft.organizationId &&
            entry.status === 'approved' &&
            entry.fingerprint === draft.fingerprint,
        );
        const candidate: KnowledgeCandidate = {
          id: randomUUID(),
          tenantId: draft.tenantId,
          organizationId: draft.organizationId,
          productId: draft.productId,
          kind: draft.kind,
          title: draft.title,
          content: draft.content,
          reasoning: draft.reasoning,
          riskFlags: draft.riskFlags,
          validationFlags: draft.validationFlags,
          legalRisk: draft.legalRisk,
          sourceCallId: draft.sourceCallId,
          sourceMeetingMinuteId: draft.sourceMeetingMinuteId,
          sourceTranscriptRevisionId: draft.sourceTranscriptRevisionId,
          sourceSegmentIds: draft.sourceSegmentIds,
          sourceEvidenceHash: draft.sourceEvidenceHash,
          fingerprint: draft.fingerprint,
          status: duplicateEntry ? 'duplicate' : 'pending',
          duplicateOfKnowledgeEntryId: duplicateEntry?.id ?? null,
          publishedKnowledgeEntryId: null,
          reviewNote: null,
          reviewedByUserId: null,
          reviewedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        candidates = [candidate, ...candidates];
        created.push(candidate);
      }

      return {
        next: { entries: revalidationEntries, candidates },
        result: created,
      };
    });
  }

  async listCandidates(
    scope: KnowledgeScope,
    filter: { productId?: ProductId; status?: KnowledgeCandidateStatus } = {},
  ): Promise<KnowledgeCandidate[]> {
    const data = await this.get();
    return data.candidates.filter(
      (candidate) =>
        candidate.tenantId === scope.tenantId &&
        candidate.organizationId === scope.organizationId &&
        (!filter.productId || candidate.productId === filter.productId) &&
        (!filter.status || candidate.status === filter.status),
    );
  }

  async syncCandidates(candidates: KnowledgeCandidate[]): Promise<void> {
    if (candidates.length === 0) return;
    await this.mutate(async (data) => {
      const incomingById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      const retained = data.candidates.filter((candidate) => !incomingById.has(candidate.id));
      return {
        next: { ...data, candidates: [...candidates, ...retained] },
        result: undefined,
      };
    });
  }

  async reviewCandidate(
    scope: KnowledgeScope,
    input: KnowledgeCandidateReview,
  ): Promise<KnowledgeCandidate> {
    return this.mutate(async (data) => {
      const candidate = data.candidates.find(
        (item) =>
          item.id === input.id &&
          item.tenantId === scope.tenantId &&
          item.organizationId === scope.organizationId,
      );
      if (!candidate) {
        throw new Error('Knowledge candidate was not found');
      }
      if (candidate.status !== 'pending') {
        throw new Error('Knowledge candidate is no longer pending');
      }

      const now = new Date().toISOString();
      if (input.decision === 'reject') {
        const rejected: KnowledgeCandidate = {
          ...candidate,
          status: 'rejected',
          reviewNote: input.reviewNote ?? null,
          reviewedByUserId: input.reviewerUserId,
          reviewedAt: now,
          updatedAt: now,
        };
        return replaceCandidate(data, rejected);
      }

      if (candidate.legalRisk === 'blocked') {
        throw new Error('Blocked knowledge candidate cannot be approved');
      }

      const title = maskPiiInText(input.title ?? candidate.title).trim();
      const content = maskPiiInText(input.content ?? candidate.content).trim();
      if (!title || !content) {
        throw new Error('Knowledge candidate title and content are required');
      }
      const fingerprint = createKnowledgeFingerprint({
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        trigger: title,
        response: content,
      });
      const duplicate = data.entries.find(
        (entry) =>
          entry.tenantId === scope.tenantId &&
          entry.organizationId === scope.organizationId &&
          entry.status === 'approved' &&
          entry.fingerprint === fingerprint,
      );
      if (duplicate) {
        const duplicateCandidate: KnowledgeCandidate = {
          ...candidate,
          title,
          content,
          fingerprint,
          status: 'duplicate',
          duplicateOfKnowledgeEntryId: duplicate.id,
          reviewNote: input.reviewNote ?? null,
          reviewedByUserId: input.reviewerUserId,
          reviewedAt: now,
          updatedAt: now,
        };
        return replaceCandidate(data, duplicateCandidate);
      }

      const entry: KnowledgeEntry = {
        id: randomUUID(),
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        productId: candidate.productId,
        objectionType: input.objectionType ?? `meeting_${candidate.kind}`,
        trigger: title,
        response: content,
        reasoning: candidate.reasoning,
        riskFlags: candidate.riskFlags,
        sourceType: 'meeting',
        sourceCallId: candidate.sourceCallId,
        sourceMeetingMinuteId: candidate.sourceMeetingMinuteId,
        sourceTranscriptRevisionId: candidate.sourceTranscriptRevisionId,
        status: 'approved',
        fingerprint,
        approvedByUserId: input.reviewerUserId,
        approvedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      const approved: KnowledgeCandidate = {
        ...candidate,
        title,
        content,
        fingerprint,
        status: 'approved',
        publishedKnowledgeEntryId: entry.id,
        reviewNote: input.reviewNote ?? null,
        reviewedByUserId: input.reviewerUserId,
        reviewedAt: now,
        updatedAt: now,
      };
      return {
        next: {
          entries: [entry, ...data.entries],
          candidates: data.candidates.map((item) => (item.id === approved.id ? approved : item)),
        },
        result: approved,
      };
    });
  }

  private async adoptLegacyEntries(scope: KnowledgeScope): Promise<void> {
    await this.mutate(async (data) => {
      if (!data.entries.some((entry) => entry.sourceType === 'legacy')) {
        return { next: data, result: undefined };
      }
      const now = new Date().toISOString();
      return {
        next: {
          ...data,
          entries: data.entries.map((entry) =>
            entry.sourceType === 'legacy'
              ? {
                  ...entry,
                  tenantId: scope.tenantId,
                  organizationId: scope.organizationId,
                  sourceType: 'manual' as const,
                  fingerprint:
                    entry.fingerprint ??
                    createKnowledgeFingerprint({
                      tenantId: scope.tenantId,
                      organizationId: scope.organizationId,
                      trigger: entry.trigger,
                      response: entry.response,
                    }),
                  updatedAt: now,
                }
              : entry,
          ),
        },
        result: undefined,
      };
    });
  }

  private async get(): Promise<LocalKnowledgeData> {
    if (this.cache) {
      return this.cache;
    }
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.cache = LocalKnowledgeDataSchema.parse(JSON.parse(raw));
      return this.cache;
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        throw error;
      }
      const initialized = createDefaultKnowledgeData();
      await this.persist(initialized);
      this.cache = initialized;
      return initialized;
    }
  }

  private mutate<T>(
    operation: (data: LocalKnowledgeData) => Promise<{ next: LocalKnowledgeData; result: T }>,
  ): Promise<T> {
    const run = this.mutationQueue.then(async () => {
      const data = await this.get();
      const { next, result } = await operation(data);
      if (next !== data) {
        await this.persist(next);
        this.cache = next;
      }
      return result;
    });
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async persist(data: LocalKnowledgeData): Promise<void> {
    await writeFileAtomic(this.filePath, `${JSON.stringify(data, null, 2)}\n`);
  }
}

export const localKnowledgeStore = new LocalKnowledgeStore();

export function createKnowledgeFingerprint(input: {
  tenantId: string | null;
  organizationId: string | null;
  trigger: string;
  response: string;
}): string {
  return createHash('sha256')
    .update(
      [input.tenantId ?? 'global', input.organizationId ?? 'global', normalizeText(input.trigger), normalizeText(input.response)].join(
        '\0',
      ),
    )
    .digest('hex');
}

function replaceCandidate(
  data: LocalKnowledgeData,
  candidate: KnowledgeCandidate,
): { next: LocalKnowledgeData; result: KnowledgeCandidate } {
  return {
    next: {
      ...data,
      candidates: data.candidates.map((item) => (item.id === candidate.id ? candidate : item)),
    },
    result: candidate,
  };
}

function assertCandidateBatch(
  drafts: KnowledgeCandidateDraft[],
  first: KnowledgeCandidateDraft,
): void {
  if (
    drafts.some(
      (draft) =>
        draft.tenantId !== first.tenantId ||
        draft.organizationId !== first.organizationId ||
        draft.sourceCallId !== first.sourceCallId ||
        draft.sourceMeetingMinuteId !== first.sourceMeetingMinuteId,
    )
  ) {
    throw new Error('Knowledge candidate batch must share one meeting source');
  }
}

function isEntryVisible(entry: KnowledgeEntry, scope?: KnowledgeScope): boolean {
  if (!scope) {
    return true;
  }
  return (
    entry.sourceType === 'builtin' ||
    (entry.tenantId === scope.tenantId && entry.organizationId === scope.organizationId)
  );
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('ja-JP');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function defaultUserDataPath(): string {
  return process.env.SALES_TALK_USER_DATA_PATH ?? app?.getPath?.('userData') ?? process.cwd();
}
