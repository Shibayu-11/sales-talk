import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';

import {
  AccountLifecycleError,
  assertD1MutationChanged,
  createConditionalRequestAuditStatement,
  createRequestAuditStatement,
  type RequestContext,
} from './account-lifecycle';

type ProductId = 'real_estate' | 'kenko_keiei' | 'hojokin';
type CandidateKind = 'summary' | 'agreed' | 'decision' | 'pending' | 'number';
type CandidateStatus = 'pending' | 'approved' | 'rejected' | 'superseded' | 'duplicate';
type LegalRisk = 'none' | 'review' | 'blocked';

const PRODUCT_IDS = new Set<ProductId>(['real_estate', 'kenko_keiei', 'hojokin']);
const CANDIDATE_KINDS = new Set<CandidateKind>([
  'summary',
  'agreed',
  'decision',
  'pending',
  'number',
]);
const CANDIDATE_STATUSES = new Set<CandidateStatus>([
  'pending',
  'approved',
  'rejected',
  'superseded',
  'duplicate',
]);
const LEGAL_RISKS = new Set<LegalRisk>(['none', 'review', 'blocked']);
const KNOWLEDGE_MANAGERS = new Set(['insurer_admin', 'agency_admin', 'manager']);

export interface KnowledgeCandidateInput {
  id: string;
  productId: ProductId;
  kind: CandidateKind;
  title: string;
  content: string;
  reasoning: string;
  riskFlags: string[];
  validationFlags: string[];
  legalRisk: LegalRisk;
  sourceCallId: string;
  sourceMeetingMinuteId: string;
  sourceTranscriptRevisionId: string | null;
  sourceSegmentIds: string[];
  sourceEvidenceHash: string;
  fingerprint: string;
}

export interface KnowledgeCandidateReviewInput {
  decision: 'approve' | 'reject';
  title?: string | undefined;
  content?: string | undefined;
  objectionType?: string | undefined;
  reviewNote?: string | undefined;
}

interface CandidateRow {
  id: string;
  tenant_id: string;
  organization_id: string;
  product_id: ProductId;
  kind: CandidateKind;
  title: string;
  content: string;
  reasoning: string;
  risk_flags_json: string;
  validation_flags_json: string;
  legal_risk: LegalRisk;
  source_call_id: string;
  source_meeting_minute_id: string;
  source_transcript_revision_id: string | null;
  source_segment_ids_json: string;
  source_evidence_hash: string;
  fingerprint: string;
  status: CandidateStatus;
  duplicate_of_knowledge_item_id: string | null;
  published_knowledge_item_id: string | null;
  review_note: string | null;
  reviewed_by_user_id: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface KnowledgeRow {
  id: string;
  tenant_id: string;
  organization_id: string;
  product_id: ProductId;
  objection_type: string;
  trigger_text: string;
  response_text: string;
  reasoning: string;
  risk_flags_json: string;
  source_type: 'manual' | 'meeting';
  source_call_id: string | null;
  source_meeting_minute_id: string | null;
  source_transcript_revision_id: string | null;
  content_hash: string;
  approved_by_user_id: string;
  approved_at: string;
  created_at: string;
  updated_at: string;
}

export function parseKnowledgeCandidateBatch(value: unknown): KnowledgeCandidateInput[] {
  const record = requireRecord(value, 'invalid_knowledge_candidate_batch');
  if (!Array.isArray(record.candidates) || record.candidates.length === 0) {
    throw new AccountLifecycleError(400, 'knowledge_candidates_required');
  }
  if (record.candidates.length > 25) {
    throw new AccountLifecycleError(400, 'too_many_knowledge_candidates');
  }
  const candidates = record.candidates.map(parseCandidate);
  const first = candidates[0];
  if (
    !first ||
    candidates.some(
      (candidate) =>
        candidate.sourceCallId !== first.sourceCallId ||
        candidate.sourceMeetingMinuteId !== first.sourceMeetingMinuteId ||
        candidate.sourceTranscriptRevisionId !== first.sourceTranscriptRevisionId,
    )
  ) {
    throw new AccountLifecycleError(400, 'knowledge_candidate_source_mismatch');
  }
  return candidates;
}

export function parseKnowledgeCandidateReview(value: unknown): KnowledgeCandidateReviewInput {
  const record = requireRecord(value, 'invalid_knowledge_candidate_review');
  if (record.decision !== 'approve' && record.decision !== 'reject') {
    throw new AccountLifecycleError(400, 'invalid_knowledge_review_decision');
  }
  const reviewNote = optionalString(record.reviewNote, 1_000);
  if (record.decision === 'reject' && !reviewNote) {
    throw new AccountLifecycleError(400, 'knowledge_rejection_note_required');
  }
  return {
    decision: record.decision,
    title: optionalString(record.title, 500),
    content: optionalString(record.content, 4_000),
    objectionType: optionalString(record.objectionType, 80),
    reviewNote,
  };
}

export async function saveKnowledgeCandidates(
  database: D1Database,
  context: RequestContext,
  candidates: KnowledgeCandidateInput[],
): Promise<unknown[]> {
  if (context.role === 'auditor') {
    throw new AccountLifecycleError(403, 'knowledge_candidate_submission_forbidden');
  }
  const first = candidates[0];
  if (!first) return [];
  const timestamp = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `UPDATE knowledge_candidates
         SET status = 'superseded', updated_at = ?
         WHERE tenant_id = ? AND organization_id = ? AND source_call_id = ?
           AND source_meeting_minute_id <> ? AND status = 'pending'`,
      )
      .bind(
        timestamp,
        context.tenantId,
        context.organizationId,
        first.sourceCallId,
        first.sourceMeetingMinuteId,
      ),
    database
      .prepare(
        `UPDATE knowledge_items
         SET status = 'needs_revalidation', updated_at = ?
         WHERE tenant_id = ? AND organization_id = ? AND source_call_id = ?
           AND COALESCE(source_transcript_revision_id, '') <> COALESCE(?, '')
           AND status = 'active'`,
      )
      .bind(
        timestamp,
        context.tenantId,
        context.organizationId,
        first.sourceCallId,
        first.sourceTranscriptRevisionId,
      ),
  ];

  for (const candidate of candidates) {
    statements.push(candidateInsertStatement(database, context, candidate, timestamp));
  }
  statements.push(
    await createRequestAuditStatement(database, context, {
      action: 'knowledge.candidates_extracted',
      targetType: 'meeting_minute',
      targetId: first.sourceMeetingMinuteId,
      metadata: {
        callId: first.sourceCallId,
        candidateCount: candidates.length,
        transcriptRevisionId: first.sourceTranscriptRevisionId,
      },
      createdAt: timestamp,
    }),
  );
  await database.batch(statements);
  return listKnowledgeCandidates(database, context, {
    sourceMeetingMinuteId: first.sourceMeetingMinuteId,
  });
}

export async function listKnowledgeCandidates(
  database: D1Database,
  context: RequestContext,
  filter: {
    productId?: ProductId | undefined;
    status?: CandidateStatus | undefined;
    sourceMeetingMinuteId?: string | undefined;
  },
): Promise<unknown[]> {
  const conditions = ['tenant_id = ?', 'organization_id = ?'];
  const bindings: Array<string> = [context.tenantId, context.organizationId];
  if (filter.productId) {
    conditions.push('product_id = ?');
    bindings.push(filter.productId);
  }
  if (filter.status) {
    conditions.push('status = ?');
    bindings.push(filter.status);
  }
  if (filter.sourceMeetingMinuteId) {
    conditions.push('source_meeting_minute_id = ?');
    bindings.push(filter.sourceMeetingMinuteId);
  }
  const result = await database
    .prepare(
      `SELECT * FROM knowledge_candidates
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT 500`,
    )
    .bind(...bindings)
    .all<CandidateRow>();
  return result.results.map(mapCandidate);
}

export async function reviewKnowledgeCandidate(
  database: D1Database,
  context: RequestContext,
  candidateId: string,
  input: KnowledgeCandidateReviewInput,
): Promise<unknown> {
  assertKnowledgeManager(context);
  const candidate = await findCandidate(database, context, candidateId);
  if (candidate.status !== 'pending') {
    throw new AccountLifecycleError(409, 'knowledge_candidate_not_pending');
  }
  if (input.decision === 'approve' && candidate.legal_risk === 'blocked') {
    throw new AccountLifecycleError(409, 'knowledge_candidate_blocked');
  }

  const timestamp = new Date().toISOString();
  const claimId = crypto.randomUUID();
  if (input.decision === 'reject') {
    const audit = await createConditionalRequestAuditStatement(
      database,
      context,
      {
        action: 'knowledge.candidate_rejected',
        targetType: 'knowledge_candidate',
        targetId: candidateId,
        metadata: { reviewNote: input.reviewNote ?? null },
        createdAt: timestamp,
      },
      'SELECT 1 FROM knowledge_candidates WHERE id = ? AND review_claim_id = ?',
      [candidateId, claimId],
    );
    const results = await database.batch([
      candidateReviewClaimStatement(database, context, candidateId, claimId, 'rejected', input, timestamp),
      audit,
    ]);
    assertD1MutationChanged(results[0], 'knowledge_candidate_not_pending');
    return mapCandidate(await findCandidate(database, context, candidateId));
  }

  const title = normalizeRequired(input.title ?? candidate.title, 500, 'invalid_knowledge_title');
  const content = normalizeRequired(
    input.content ?? candidate.content,
    4_000,
    'invalid_knowledge_content',
  );
  const objectionType = normalizeRequired(
    input.objectionType ?? `meeting_${candidate.kind}`,
    80,
    'invalid_objection_type',
  );
  assertPublishableKnowledgeContent(candidate.product_id, `${title}\n${content}`);
  const contentHash = await sha256(
    [context.tenantId, context.organizationId, title, content].join('\0'),
  );
  const duplicate = await database
    .prepare(
      `SELECT i.id
       FROM knowledge_items i
       JOIN knowledge_revisions r ON r.id = i.current_revision_id
       WHERE i.tenant_id = ? AND i.organization_id = ? AND i.status = 'active'
         AND r.content_hash = ?
       LIMIT 1`,
    )
    .bind(context.tenantId, context.organizationId, contentHash)
    .first<{ id: string }>();
  if (duplicate) {
    const audit = await createConditionalRequestAuditStatement(
      database,
      context,
      {
        action: 'knowledge.candidate_approved',
        targetType: 'knowledge_candidate',
        targetId: candidateId,
        metadata: { duplicate: true, knowledgeItemId: duplicate.id },
        createdAt: timestamp,
      },
      'SELECT 1 FROM knowledge_candidates WHERE id = ? AND review_claim_id = ?',
      [candidateId, claimId],
    );
    const results = await database.batch([
      database
        .prepare(
          `UPDATE knowledge_candidates
           SET status = 'duplicate', duplicate_of_knowledge_item_id = ?, review_note = ?,
             reviewed_by_user_id = ?, reviewed_at = ?, review_claim_id = ?, updated_at = ?
           WHERE id = ? AND tenant_id = ? AND organization_id = ? AND status = 'pending'`,
        )
        .bind(
          duplicate.id,
          input.reviewNote ?? null,
          context.userId,
          timestamp,
          claimId,
          timestamp,
          candidateId,
          context.tenantId,
          context.organizationId,
        ),
      audit,
    ]);
    assertD1MutationChanged(results[0], 'knowledge_candidate_not_pending');
    return mapCandidate(await findCandidate(database, context, candidateId));
  }

  const itemId = crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  const outboxId = crypto.randomUUID();
  const audit = await createConditionalRequestAuditStatement(
    database,
    context,
    {
      action: 'knowledge.candidate_approved',
      targetType: 'knowledge_candidate',
      targetId: candidateId,
      metadata: { duplicate: false, knowledgeItemId: itemId, revisionId },
      createdAt: timestamp,
    },
    'SELECT 1 FROM knowledge_candidates WHERE id = ? AND review_claim_id = ?',
    [candidateId, claimId],
  );
  const claim = candidateReviewClaimStatement(
    database,
    context,
    candidateId,
    claimId,
    'approved',
    { ...input, title, content },
    timestamp,
    itemId,
  );
  const conditional =
    'SELECT 1 FROM knowledge_candidates WHERE id = ? AND review_claim_id = ?';
  const conditionalBindings = [candidateId, claimId];
  const results = await database.batch([
    claim,
    database
      .prepare(
        `INSERT INTO knowledge_items (
          id, tenant_id, organization_id, product_id, objection_type, source_type,
          source_call_id, source_meeting_minute_id, source_transcript_revision_id,
          current_revision_id, status, created_at, updated_at
        ) SELECT ?, ?, ?, ?, ?, 'meeting', ?, ?, ?, ?, 'active', ?, ?
          WHERE EXISTS (${conditional})`,
      )
      .bind(
        itemId,
        context.tenantId,
        context.organizationId,
        candidate.product_id,
        objectionType,
        candidate.source_call_id,
        candidate.source_meeting_minute_id,
        candidate.source_transcript_revision_id,
        revisionId,
        timestamp,
        timestamp,
        ...conditionalBindings,
      ),
    database
      .prepare(
        `INSERT INTO knowledge_revisions (
          id, knowledge_item_id, tenant_id, organization_id, version, candidate_id,
          trigger_text, response_text, reasoning, risk_flags_json, content_hash,
          embedding_status, approved_by_user_id, approved_at, published_at, created_at
        ) SELECT ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, NULL, ?
          WHERE EXISTS (${conditional})`,
      )
      .bind(
        revisionId,
        itemId,
        context.tenantId,
        context.organizationId,
        candidateId,
        title,
        content,
        candidate.reasoning,
        candidate.risk_flags_json,
        contentHash,
        context.userId,
        timestamp,
        timestamp,
        ...conditionalBindings,
      ),
    database
      .prepare(
        `INSERT INTO knowledge_publish_outbox (
          id, tenant_id, organization_id, candidate_id, knowledge_revision_id,
          idempotency_key, status, attempt_count, last_error, created_at, updated_at
        ) SELECT ?, ?, ?, ?, ?, ?, 'queued', 0, NULL, ?, ?
          WHERE EXISTS (${conditional})`,
      )
      .bind(
        outboxId,
        context.tenantId,
        context.organizationId,
        candidateId,
        revisionId,
        `knowledge-revision:${revisionId}`,
        timestamp,
        timestamp,
        ...conditionalBindings,
      ),
    audit,
  ]);
  assertD1MutationChanged(results[0], 'knowledge_candidate_not_pending');
  return mapCandidate(await findCandidate(database, context, candidateId));
}

export async function searchPublishedKnowledge(
  database: D1Database,
  context: RequestContext,
  input: { productId: ProductId; query: string; limit: number },
): Promise<unknown[]> {
  const query = normalizeRequired(input.query, 500, 'invalid_knowledge_query');
  const like = `%${escapeLike(query)}%`;
  const result = await database
    .prepare(
      `SELECT i.id, i.tenant_id, i.organization_id, i.product_id, i.objection_type,
        r.trigger_text, r.response_text, r.reasoning, r.risk_flags_json,
        i.source_type, i.source_call_id, i.source_meeting_minute_id,
        i.source_transcript_revision_id, r.content_hash, r.approved_by_user_id,
        r.approved_at, i.created_at, i.updated_at
       FROM knowledge_items i
       JOIN knowledge_revisions r ON r.id = i.current_revision_id
       WHERE i.tenant_id = ? AND i.organization_id = ? AND i.product_id = ?
         AND i.status = 'active'
         AND (r.trigger_text LIKE ? ESCAPE '\\' OR r.response_text LIKE ? ESCAPE '\\'
           OR r.reasoning LIKE ? ESCAPE '\\' OR i.objection_type LIKE ? ESCAPE '\\')
       ORDER BY i.updated_at DESC, i.id DESC
       LIMIT ?`,
    )
    .bind(
      context.tenantId,
      context.organizationId,
      input.productId,
      like,
      like,
      like,
      like,
      input.limit,
    )
    .all<KnowledgeRow>();
  return result.results.map(mapKnowledge);
}

export function parseKnowledgeCandidateFilter(url: URL): {
  productId?: ProductId | undefined;
  status?: CandidateStatus | undefined;
} {
  const product = url.searchParams.get('productId');
  const status = url.searchParams.get('status');
  if (product && !PRODUCT_IDS.has(product as ProductId)) {
    throw new AccountLifecycleError(400, 'invalid_product_id');
  }
  if (status && !CANDIDATE_STATUSES.has(status as CandidateStatus)) {
    throw new AccountLifecycleError(400, 'invalid_knowledge_candidate_status');
  }
  return {
    ...(product ? { productId: product as ProductId } : {}),
    ...(status ? { status: status as CandidateStatus } : {}),
  };
}

export function parseKnowledgeSearch(url: URL): {
  productId: ProductId;
  query: string;
  limit: number;
} {
  const product = url.searchParams.get('productId');
  if (!product || !PRODUCT_IDS.has(product as ProductId)) {
    throw new AccountLifecycleError(400, 'invalid_product_id');
  }
  const query = normalizeRequired(
    url.searchParams.get('query') ?? '',
    500,
    'invalid_knowledge_query',
  );
  const rawLimit = Number(url.searchParams.get('limit') ?? '10');
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 20) {
    throw new AccountLifecycleError(400, 'invalid_knowledge_limit');
  }
  return { productId: product as ProductId, query, limit: rawLimit };
}

function candidateInsertStatement(
  database: D1Database,
  context: RequestContext,
  candidate: KnowledgeCandidateInput,
  timestamp: string,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT OR IGNORE INTO knowledge_candidates (
        id, tenant_id, organization_id, product_id, kind, title, content, reasoning,
        risk_flags_json, validation_flags_json, legal_risk, source_call_id,
        source_meeting_minute_id, source_transcript_revision_id, source_segment_ids_json,
        source_evidence_hash, fingerprint, status, duplicate_of_knowledge_item_id,
        published_knowledge_item_id, review_note, reviewed_by_user_id, reviewed_at,
        review_claim_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending',
        NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    )
    .bind(
      candidate.id,
      context.tenantId,
      context.organizationId,
      candidate.productId,
      candidate.kind,
      candidate.title,
      candidate.content,
      candidate.reasoning,
      JSON.stringify(candidate.riskFlags),
      JSON.stringify(candidate.validationFlags),
      candidate.legalRisk,
      candidate.sourceCallId,
      candidate.sourceMeetingMinuteId,
      candidate.sourceTranscriptRevisionId,
      JSON.stringify(candidate.sourceSegmentIds),
      candidate.sourceEvidenceHash,
      candidate.fingerprint,
      timestamp,
      timestamp,
    );
}

function candidateReviewClaimStatement(
  database: D1Database,
  context: RequestContext,
  candidateId: string,
  claimId: string,
  status: 'approved' | 'rejected',
  input: KnowledgeCandidateReviewInput,
  timestamp: string,
  publishedKnowledgeItemId: string | null = null,
): D1PreparedStatement {
  return database
    .prepare(
      `UPDATE knowledge_candidates
       SET status = ?, title = COALESCE(?, title), content = COALESCE(?, content),
         published_knowledge_item_id = ?, review_note = ?, reviewed_by_user_id = ?,
         reviewed_at = ?, review_claim_id = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ? AND organization_id = ? AND status = 'pending'`,
    )
    .bind(
      status,
      input.title ?? null,
      input.content ?? null,
      publishedKnowledgeItemId,
      input.reviewNote ?? null,
      context.userId,
      timestamp,
      claimId,
      timestamp,
      candidateId,
      context.tenantId,
      context.organizationId,
    );
}

async function findCandidate(
  database: D1Database,
  context: RequestContext,
  candidateId: string,
): Promise<CandidateRow> {
  const row = await database
    .prepare(
      `SELECT * FROM knowledge_candidates
       WHERE id = ? AND tenant_id = ? AND organization_id = ?`,
    )
    .bind(candidateId, context.tenantId, context.organizationId)
    .first<CandidateRow>();
  if (!row) throw new AccountLifecycleError(404, 'knowledge_candidate_not_found');
  return row;
}

function mapCandidate(row: CandidateRow): unknown {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    productId: row.product_id,
    kind: row.kind,
    title: row.title,
    content: row.content,
    reasoning: row.reasoning,
    riskFlags: parseStringArray(row.risk_flags_json),
    validationFlags: parseStringArray(row.validation_flags_json),
    legalRisk: row.legal_risk,
    sourceCallId: row.source_call_id,
    sourceMeetingMinuteId: row.source_meeting_minute_id,
    sourceTranscriptRevisionId: row.source_transcript_revision_id,
    sourceSegmentIds: parseStringArray(row.source_segment_ids_json),
    sourceEvidenceHash: row.source_evidence_hash,
    fingerprint: row.fingerprint,
    status: row.status,
    duplicateOfKnowledgeEntryId: row.duplicate_of_knowledge_item_id,
    publishedKnowledgeEntryId: row.published_knowledge_item_id,
    reviewNote: row.review_note,
    reviewedByUserId: row.reviewed_by_user_id,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapKnowledge(row: KnowledgeRow): unknown {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    productId: row.product_id,
    objectionType: row.objection_type,
    trigger: row.trigger_text,
    response: row.response_text,
    reasoning: row.reasoning,
    riskFlags: parseStringArray(row.risk_flags_json),
    sourceType: row.source_type,
    sourceCallId: row.source_call_id,
    sourceMeetingMinuteId: row.source_meeting_minute_id,
    sourceTranscriptRevisionId: row.source_transcript_revision_id,
    status: 'approved',
    fingerprint: row.content_hash,
    approvedByUserId: row.approved_by_user_id,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseCandidate(value: unknown): KnowledgeCandidateInput {
  const record = requireRecord(value, 'invalid_knowledge_candidate');
  const productId = requiredEnum(record.productId, PRODUCT_IDS, 'invalid_product_id');
  const kind = requiredEnum(record.kind, CANDIDATE_KINDS, 'invalid_knowledge_candidate_kind');
  const legalRisk = requiredEnum(record.legalRisk, LEGAL_RISKS, 'invalid_knowledge_legal_risk');
  const candidate: KnowledgeCandidateInput = {
    id: requiredUuid(record.id, 'invalid_knowledge_candidate_id'),
    productId,
    kind,
    title: normalizeRequired(record.title, 500, 'invalid_knowledge_title'),
    content: normalizeRequired(record.content, 4_000, 'invalid_knowledge_content'),
    reasoning: normalizeOptional(record.reasoning, 1_000),
    riskFlags: requiredStringArray(record.riskFlags, 10, 80),
    validationFlags: requiredStringArray(record.validationFlags, 10, 80),
    legalRisk,
    sourceCallId: requiredUuid(record.sourceCallId, 'invalid_source_call_id'),
    sourceMeetingMinuteId: requiredUuid(record.sourceMeetingMinuteId, 'invalid_source_minute_id'),
    sourceTranscriptRevisionId: nullableUuid(
      record.sourceTranscriptRevisionId,
      'invalid_source_transcript_revision_id',
    ),
    sourceSegmentIds: requiredUuidArray(record.sourceSegmentIds, 500),
    sourceEvidenceHash: requiredHash(record.sourceEvidenceHash, 'invalid_source_evidence_hash'),
    fingerprint: requiredHash(record.fingerprint, 'invalid_knowledge_fingerprint'),
  };
  assertNoSensitivePii(`${candidate.title}\n${candidate.content}\n${candidate.reasoning}`);
  return candidate;
}

function assertKnowledgeManager(context: RequestContext): void {
  if (!KNOWLEDGE_MANAGERS.has(context.role)) {
    throw new AccountLifecycleError(403, 'knowledge_manager_required');
  }
}

function requireRecord(value: unknown, error: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AccountLifecycleError(400, error);
  }
  return value as Record<string, unknown>;
}

function normalizeRequired(value: unknown, max: number, error: string): string {
  if (typeof value !== 'string') throw new AccountLifecycleError(400, error);
  const normalized = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > max) throw new AccountLifecycleError(400, error);
  return normalized;
}

function normalizeOptional(value: unknown, max: number): string {
  if (value === undefined || value === null) return '';
  return normalizeRequired(value, max, 'invalid_optional_text');
}

function optionalString(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return normalizeRequired(value, max, 'invalid_optional_text');
}

function requiredUuid(value: unknown, error: string): string {
  if (typeof value !== 'string' || !isUuid(value)) throw new AccountLifecycleError(400, error);
  return value;
}

function nullableUuid(value: unknown, error: string): string | null {
  if (value === null || value === undefined) return null;
  return requiredUuid(value, error);
}

function requiredUuidArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value) || value.length > max || value.some((item) => !isUuid(item))) {
    throw new AccountLifecycleError(400, 'invalid_source_segment_ids');
  }
  return value as string[];
}

function requiredStringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (
    !Array.isArray(value) ||
    value.length > maxItems ||
    value.some((item) => typeof item !== 'string' || item.length === 0 || item.length > maxLength)
  ) {
    throw new AccountLifecycleError(400, 'invalid_string_array');
  }
  return value as string[];
}

function requiredEnum<T extends string>(value: unknown, values: Set<T>, error: string): T {
  if (typeof value !== 'string' || !values.has(value as T)) {
    throw new AccountLifecycleError(400, error);
  }
  return value as T;
}

function requiredHash(value: unknown, error: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new AccountLifecycleError(400, error);
  }
  return value;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function assertPublishableKnowledgeContent(productId: ProductId, value: string): void {
  assertNoSensitivePii(value);
  const patterns: Record<ProductId, RegExp[]> = {
    real_estate: [/利回り.*(保証|確実|必ず)/, /元本保証/, /節税.*(確実|必ず|保証|断定)/],
    hojokin: [/採択.*(確実|必ず|保証)/, /100%.*採択/, /虚偽申請|架空経費|水増し/],
    kenko_keiei: [
      /認定.*(確実|必ず|保証)/,
      /離職率.*(必ず|確実).*下が/,
      /生産性.*(必ず|確実).*上が/,
    ],
  };
  if (patterns[productId].some((pattern) => pattern.test(value))) {
    throw new AccountLifecycleError(409, 'knowledge_content_guardrail_blocked');
  }
}

function assertNoSensitivePii(value: string): void {
  const patterns = [
    /(\+81|0)\d{1,4}-?\d{1,4}-?\d{4}/,
    /[\w._%+-]+@[\w.-]+\.[A-Za-z]{2,}/,
    /\b(?:\d[ -]*?){13,16}\b/,
    /〒?\d{3}-?\d{4}/,
    /[一-龥々]{2,6}(?:さん|様|氏)/,
    /(?:東京都|北海道|(?:京都|大阪)府|[一-龥]{2,3}県)[^\s、。]{2,30}(?:市|区|町|村|郡|丁目|番地|号)/,
  ];
  if (patterns.some((pattern) => pattern.test(value))) {
    throw new AccountLifecycleError(400, 'knowledge_candidate_contains_pii');
  }
}
