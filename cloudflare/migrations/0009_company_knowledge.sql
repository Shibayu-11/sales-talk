PRAGMA foreign_keys = ON;

CREATE TABLE knowledge_candidates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  product_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('summary', 'agreed', 'decision', 'pending', 'number')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  risk_flags_json TEXT NOT NULL,
  validation_flags_json TEXT NOT NULL,
  legal_risk TEXT NOT NULL CHECK (legal_risk IN ('none', 'review', 'blocked')),
  source_call_id TEXT NOT NULL,
  source_meeting_minute_id TEXT NOT NULL,
  source_transcript_revision_id TEXT,
  source_segment_ids_json TEXT NOT NULL,
  source_evidence_hash TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'superseded', 'duplicate')),
  duplicate_of_knowledge_item_id TEXT,
  published_knowledge_item_id TEXT,
  review_note TEXT,
  reviewed_by_user_id TEXT REFERENCES users(id),
  reviewed_at TEXT,
  review_claim_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(tenant_id, organization_id, source_meeting_minute_id, fingerprint)
);

CREATE INDEX knowledge_candidates_review_idx
ON knowledge_candidates(tenant_id, organization_id, status, product_id, created_at DESC);

CREATE INDEX knowledge_candidates_call_idx
ON knowledge_candidates(tenant_id, organization_id, source_call_id, created_at DESC);

CREATE TABLE knowledge_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  product_id TEXT NOT NULL,
  objection_type TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('manual', 'meeting')),
  source_call_id TEXT,
  source_meeting_minute_id TEXT,
  source_transcript_revision_id TEXT,
  current_revision_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'needs_revalidation', 'deprecated', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX knowledge_items_search_scope_idx
ON knowledge_items(tenant_id, organization_id, product_id, status, updated_at DESC);

CREATE INDEX knowledge_items_call_idx
ON knowledge_items(tenant_id, organization_id, source_call_id, status);

CREATE TABLE knowledge_revisions (
  id TEXT PRIMARY KEY,
  knowledge_item_id TEXT NOT NULL REFERENCES knowledge_items(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  version INTEGER NOT NULL,
  candidate_id TEXT NOT NULL REFERENCES knowledge_candidates(id),
  trigger_text TEXT NOT NULL,
  response_text TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  risk_flags_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  embedding_status TEXT NOT NULL CHECK (embedding_status IN ('queued', 'processing', 'published', 'failed')),
  approved_by_user_id TEXT NOT NULL REFERENCES users(id),
  approved_at TEXT NOT NULL,
  published_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(knowledge_item_id, version),
  UNIQUE(candidate_id)
);

CREATE INDEX knowledge_revisions_hash_idx
ON knowledge_revisions(tenant_id, organization_id, content_hash);

CREATE TABLE knowledge_publish_outbox (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  candidate_id TEXT NOT NULL REFERENCES knowledge_candidates(id),
  knowledge_revision_id TEXT NOT NULL REFERENCES knowledge_revisions(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'published', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX knowledge_publish_outbox_status_idx
ON knowledge_publish_outbox(status, created_at);
